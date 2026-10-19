"use client";

// Original printing workflow: a template image (single / co-load / tri-load by number of loads in the cluster field)
// with plate, driver, dock, docked time and loads placed at the original percentage coordinates; browser print hides
// everything else. Print is disabled until a driver is assigned.
// KNOWN GAP: the original draws the driver ID as a QR code (qrcode.react). That package cannot be installed in this
// environment and an unverified hand-written QR encoder would be unsafe on an operational label, so the driver ID is
// printed as large text only (see docs/parity-matrix.md).
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { fmtDateTime, labelKind, labelLoads, type LabelKind } from "@/lib/request-ui";

export interface LabelRequest {
  plate_number: string | null;
  driver_id: string | null;
  dock_no: string;
  cluster: string;
  docked_at: string | null;
}

const SRC: Record<LabelKind, string> = {
  single: "/printable_templates/single_lh.jpg",
  coload: "/printable_templates/coload_lh.jpg",
  triload: "/printable_templates/triload_lh.jpg",
};

function slots(kind: LabelKind, v: string[]) {
  if (kind === "single") return [{ cls: "load-single", value: v[0] ?? "" }];
  // The template boxes run right to left: source order is 1st, 2nd, 3rd load.
  if (kind === "coload") return [{ cls: "load-left", value: v[1] ?? "" }, { cls: "load-right", value: v[0] ?? "" }];
  return [{ cls: "load-third", value: v[2] ?? "" }, { cls: "load-second", value: v[1] ?? "" }, { cls: "load-first", value: v[0] ?? "" }];
}

function Fit({ value, className = "" }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      if (!el.clientWidth || !el.clientHeight) return;
      const fits = () => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
      if (fits()) return;
      let low = 1;
      let high = Number.parseFloat(getComputedStyle(el).fontSize);
      for (let i = 0; i < 10; i++) {
        const mid = (low + high) / 2;
        el.style.fontSize = `${mid}px`;
        if (fits()) low = mid;
        else high = mid;
      }
      el.style.fontSize = `${Math.floor(low * 10) / 10}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("beforeprint", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("beforeprint", fit);
    };
  }, [value]);
  return <span ref={ref} className={`ops-fit ${className}`}>{value}</span>;
}

export function PrintLabel({ request, onClose }: { request: LabelRequest; onClose: () => void }) {
  const loads = labelLoads(request.cluster);
  const kind = labelKind(loads.length);
  const driver = request.driver_id?.trim() ?? "";
  return createPortal(
    <div className="truck-label-print-root ops-label-root" role="dialog" aria-modal="true" aria-label="Printable truck label">
      <div className="ops-label-dialog print-dialog">
        <div className="ops-label-toolbar print-toolbar">
          <strong>Printable LH label</strong>
          <span>
            <button type="button" className="ops-btn ops-primary" disabled={!driver} onClick={() => window.print()}>Print</button>{" "}
            <button type="button" className="ops-btn" onClick={onClose} aria-label="Close">Close</button>
          </span>
        </div>
        <div className="ops-label-preview print-preview">
          <div className="ops-label" data-truck-label>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={SRC[kind]} alt="" className="ops-label-img" />
            <div className="ops-label-field plate" data-label-field="plate"><Fit value={request.plate_number ?? ""} /></div>
            <div className="ops-label-field driver" data-label-field="driver"><Fit value={driver} /></div>
            <div className="ops-label-field dock" data-label-field="dock"><Fit value={request.dock_no} /></div>
            <div className="ops-label-field time" data-label-field="time"><Fit value={request.docked_at ? fmtDateTime(request.docked_at) : ""} /></div>
            {slots(kind, loads).map((s) => (
              <div key={s.cls} className={`ops-label-field load ${s.cls}`} data-label-field={s.cls}><Fit value={s.value} /></div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
