"use client";

// Notifications (lead 11): real list, true unread count across every visible notice, per-item and mark-all read.
// Persistence, SeaTalk delivery and user read receipts are separate facts (NOT-3); realtime is only a refresh signal.
import { useCallback, useState } from "react";
import { apiGet, apiSend, friendlyError } from "@/lib/api-client";
import { fmtDateTime } from "@/lib/request-ui";
import { useLiveRefresh } from "@/lib/use-live";
import { Notice, useSignedIn } from "./common";

export interface Notif {
  id: string;
  event_type: string;
  title: string;
  body: string;
  request_id: string | null;
  created_at: string;
  read: boolean;
}
interface Feed {
  data: Notif[];
  unread: number;
  has_more: boolean;
}

/** Live unread count for badges (header bell, sidebar). Cheap: limit=1 returns the count over ALL visible notices. */
export function useUnreadCount(): number | null {
  const signedIn = useSignedIn();
  const [n, setN] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setN((await apiGet<Feed>("/notifications?limit=1")).unread);
    } catch {
      /* badge is best-effort */
    }
  }, []);
  useLiveRefresh(load, ["notifications"], signedIn);
  return signedIn ? n : null;
}

export function NotificationsPanel() {
  const signedIn = useSignedIn();
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [more, setMore] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const f = await apiGet<Feed>("/notifications?limit=50");
      setItems(f.data);
      setUnread(f.unread);
      setMore(f.has_more);
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  }, []);
  useLiveRefresh(load, ["notifications"], signedIn);

  const loadOlder = async () => {
    const last = items.at(-1);
    if (!last) return;
    setLoading(true);
    try {
      const f = await apiGet<Feed>(`/notifications?limit=50&before=${encodeURIComponent(last.created_at)}`);
      setItems([...items, ...f.data]);
      setMore(f.has_more);
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    } finally {
      setLoading(false);
    }
  };
  const mark = async (id: string | null) => {
    try {
      await apiSend("PATCH", id ? `/notifications/${id}/read` : "/notifications/read-all", undefined, crypto.randomUUID());
      await load();
    } catch (e) {
      setNotice({ kind: "error", text: friendlyError(e) });
    }
  };

  if (!signedIn) return null;
  return (
    <section className="panel module-content" aria-labelledby="notif-title">
      <div className="module-content-heading">
        <div>
          <h2 id="notif-title">Your notifications</h2>
          <p aria-live="polite">{unread} unread</p>
        </div>
        <button type="button" className="ops-btn" disabled={unread === 0} onClick={() => void mark(null)}>Mark all as read</button>
      </div>
      <Notice notice={notice} />
      {items.length === 0 ? (
        <p className="module-note">You have no notifications.</p>
      ) : (
        <ul className="module-list">
          {items.map((n) => (
            <li key={n.id} className={n.read ? "ops-read" : "ops-unread"}>
              <span className="module-list-marker" aria-hidden="true" style={{ opacity: n.read ? 0.25 : 1 }} />
              <span>
                <strong>{n.title}</strong>{!n.read && <small> · new</small>}
                {n.body && <><br /><small>{n.body}</small></>}
                <br /><small>{fmtDateTime(n.created_at)}{n.request_id ? ` · REQ-${n.request_id.slice(0, 8).toUpperCase()}` : ""}</small>
              </span>
              {!n.read && <button type="button" className="text-link" onClick={() => void mark(n.id)}>Mark as read</button>}
            </li>
          ))}
        </ul>
      )}
      {more && <button type="button" className="ops-btn" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading…" : "Load older"}</button>}
    </section>
  );
}
