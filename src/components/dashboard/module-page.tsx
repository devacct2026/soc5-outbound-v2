import {
  Activity,
  Bell,
  Building2,
  ChartNoAxesColumnIncreasing,
  CircleCheck,
  FileText,
  Settings,
  Truck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { ActionQueue } from "./action-queue";
import { IntradayPanel, ReportsPanel } from "@/components/ops/reports-panel";
import { NotificationsPanel } from "@/components/ops/notifications-panel";
import { RequestsWorkspace } from "@/components/ops/requests-workspace";
import { SessionGate } from "@/components/ops/session-gate";
import { UsersPanel } from "@/components/ops/users-panel";

const modules: Record<
  string,
  {
    description: string;
    icon: LucideIcon;
    metrics: [string, string, string][];
    items: string[];
  }
> = {
  Requests: {
    description: "Review and track outbound linehaul requests across all hubs.",
    icon: FileText,
    metrics: [["Open requests", "24", "Needs review"], ["Approved today", "56", "Across all hubs"], ["Rejected", "6", "Today"]],
    items: ["Search requests by ID, route, plate, or hub.", "Open a request to review its current status and ETA.", "Use the dashboard for the full request activity snapshot."],
  },
  Approvals: {
    description: "Review pending outbound requests and approval activity.",
    icon: CircleCheck,
    metrics: [["Awaiting review", "8", "Across all hubs"], ["Approved today", "56", "Today"], ["Average review", "18 min", "Current shift"]],
    items: ["Prioritize requests nearing their requested departure.", "Review route, vehicle, and requester details.", "Approval actions are not connected in this frontend prototype."],
  },
  Queue: {
    description: "Monitor trucks checked in and waiting for a loading dock.",
    icon: Truck,
    metrics: [["Trucks in queue", "18", "Across all hubs"], ["Next arrival", "12 min", "Estimated"], ["Longest wait", "34 min", "Current queue"]],
    items: ["Track checked-in trucks and estimated wait times.", "Coordinate the next available dock assignment.", "Queue updates are represented by local mock data only."],
  },
  Docking: {
    description: "View dock availability, occupancy, and maintenance status.",
    icon: Building2,
    metrics: [["Active docks", "6 / 8", "75% utilization"], ["Available", "3", "Ready for assignment"], ["Maintenance", "1", "Until 14:00"]],
    items: ["Review current dock occupancy and truck assignments.", "Identify available docks for queued vehicles.", "Dock status changes are not persisted in this prototype."],
  },
  "Intraday KPI": {
    description: "Track outbound throughput and service levels during the shift.",
    icon: ChartNoAxesColumnIncreasing,
    metrics: [["Intraday volume", "428", "Trucks dispatched"], ["SLA risk", "12%", "Current shift"], ["On-time departures", "94%", "Today"]],
    items: ["Compare hourly outbound volume with request flow.", "Monitor service-level risks during the active shift.", "All KPI values use the included sample dataset."],
  },
  Notifications: {
    description: "Review operational updates and items requiring attention.",
    icon: Bell,
    metrics: [["Unread", "3", "Needs attention"], ["Request updates", "2", "Today"], ["Dock updates", "1", "Today"]],
    items: ["Request REQ-20240423-018 was approved.", "Truck DEF 9012 arrived at the gate.", "Dock 7 is available for the next assignment."],
  },
  Users: {
    description: "Manage the operations team directory and role overview.",
    icon: UserRound,
    metrics: [["Team members", "24", "Across the operation"], ["Operations managers", "4", "Assigned"], ["Active shift", "12", "On duty"]],
    items: ["Daniel Tan — Operations Manager", "Sarah Lim — Request Coordinator", "User management is a visual placeholder only."],
  },
  Reports: {
    description: "Explore outbound performance summaries and operational reports.",
    icon: FileText,
    metrics: [["Daily volume", "428", "Trucks dispatched"], ["Request completion", "86%", "Today"], ["Average dock time", "42 min", "Current shift"]],
    items: ["Daily outbound summary — Apr 23, 2024", "Dock utilization report — Current shift", "Report export is not available in this frontend prototype."],
  },
  Settings: {
    description: "Review local display preferences and prototype configuration.",
    icon: Settings,
    metrics: [["Theme", "System", "Light or dark"], ["Time zone", "SGT", "UTC +08:00"], ["Data source", "Mock", "Local sample data"]],
    items: ["Use the theme control in the top bar to switch appearance.", "Navigation and preferences are local to this prototype.", "No account, API, or backend settings are connected."],
  },
};

export function ModulePage({ page }: { page: string }) {
  const pageModule = modules[page];
  if (!pageModule) {
    return (
      <section className="module-page" aria-labelledby="module-title">
        <div className="module-heading">
          <div>
            <h1 id="module-title">{page}</h1>
            <p>Module preview is not available.</p>
          </div>
        </div>
      </section>
    );
  }

  const Icon = pageModule.icon;
  return (
    <section className="module-page" aria-labelledby="module-title">
      <div className="module-heading">
        <div>
          <h1 id="module-title">{page}</h1>
          <p>{pageModule.description}</p>
        </div>
        <Link className="module-dashboard-link" href="/">
          <Activity size={15} aria-hidden="true" />
          View dashboard
        </Link>
      </div>
      <div className="module-metrics" aria-label={`${page} summary`}>
        {pageModule.metrics.map(([label, value, detail]) => (
          <article className="module-metric panel" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </article>
        ))}
      </div>
      <SessionGate />
      {["Queue", "Approvals", "Docking"].includes(page) && <ActionQueue page={page} />}
      {page === "Requests" && <RequestsWorkspace />}
      {page === "Notifications" && <NotificationsPanel />}
      {page === "Intraday KPI" && <IntradayPanel />}
      {page === "Reports" && <ReportsPanel />}
      {page === "Users" && <UsersPanel />}
      <section className="panel module-content" aria-labelledby="module-content-title">
        <div className="module-content-heading">
          <span className="panel-icon"><Icon size={19} aria-hidden="true" /></span>
          <div>
            <h2 id="module-content-title">{page} overview</h2>
            <p>Prototype view · sample operational data</p>
          </div>
        </div>
        <ul className="module-list">
          {pageModule.items.map((item) => (
            <li key={item}>
              <span className="module-list-marker" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
        <p className="module-note">
          This module is a frontend-only preview. No operational changes are saved.
        </p>
      </section>
    </section>
  );
}
