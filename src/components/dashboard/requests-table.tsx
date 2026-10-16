"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { LinehaulRequest, RequestStatus } from "@/lib/dashboard-data";

const statusClass: Record<RequestStatus, string> = {
  Pending: "status-pending",
  Approved: "status-approved",
  "In Queue": "status-queue",
  Docked: "status-docked",
  Completed: "status-completed",
  Rejected: "status-rejected",
};

export function RequestsTable({
  data,
  showAll,
}: {
  data: LinehaulRequest[];
  showAll: boolean;
}) {
  const [selectedRequest, setSelectedRequest] = useState<LinehaulRequest | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!selectedRequest) {
      triggerRef.current?.focus();
      return;
    }

    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedRequest(null);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedRequest]);

  const visibleData = showAll ? data : data.slice(0, 6);
  const headers = [
    "Request ID",
    "Hub",
    "Route",
    "Plate No.",
    "Requested By",
    "Status",
    "ETA",
    "Action",
  ];

  return (
    <>
      <div className="table-scroll">
        <table className="requests-table">
          <thead>
            <tr>
              {headers.map((header) => <th key={header} scope="col">{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {visibleData.map((request) => (
              <tr key={request.id}>
                <td>{request.id}</td>
                <td>{request.hub}</td>
                <td>{request.route}</td>
                <td>{request.plate}</td>
                <td>{request.requestedBy}</td>
                <td>
                  <span className={`status-pill ${statusClass[request.status]}`}>
                    <span className="status-dot" />
                    {request.status}
                  </span>
                </td>
                <td>{request.eta}</td>
                <td>
                  <button
                    type="button"
                    className="table-action"
                    aria-label={`View request ${request.id}`}
                    title="View request"
                    onClick={(event) => {
                      triggerRef.current = event.currentTarget;
                      setSelectedRequest(request);
                    }}
                  >
                    <MoreHorizontal size={15} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
            {visibleData.length === 0 && (
              <tr>
                <td colSpan={headers.length} className="empty-table">
                  No matching linehaul requests.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {selectedRequest && (
        <div
          className="request-dialog-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedRequest(null);
          }}
        >
          <section
            className="request-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="request-dialog-title"
            ref={dialogRef}
          >
            <div className="request-dialog-heading">
              <div>
                <h2 id="request-dialog-title">Request details</h2>
                <p>{selectedRequest.id}</p>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close request details"
                ref={closeButtonRef}
                onClick={() => setSelectedRequest(null)}
              >
                ×
              </button>
            </div>
            <dl className="request-details">
              <div><dt>Hub</dt><dd>{selectedRequest.hub}</dd></div>
              <div><dt>Route</dt><dd>{selectedRequest.route}</dd></div>
              <div><dt>Plate No.</dt><dd>{selectedRequest.plate}</dd></div>
              <div><dt>Requested By</dt><dd>{selectedRequest.requestedBy}</dd></div>
              <div><dt>Status</dt><dd>{selectedRequest.status}</dd></div>
              <div><dt>ETA</dt><dd>{selectedRequest.eta}</dd></div>
            </dl>
          </section>
        </div>
      )}
    </>
  );
}
