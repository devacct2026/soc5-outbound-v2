"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bell,
  Box,
  Building2,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  ChevronsLeft,
  CircleCheck,
  Clock3,
  FileText,
  House,
  List,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldAlert,
  Sun,
  Truck,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  activities,
  docks,
  kpis,
  pipeline,
  requests,
  type LinehaulRequest,
  type RequestStatus,
} from "@/lib/dashboard-data";
import { HourlyVolumeChart, RequestFlowChart, type ChartMetric, type ReportingPeriod } from "./charts";
import { ModulePage } from "./module-page";
import { RequestsTable } from "./requests-table";

const navigation = [
  { label: "Dashboard", href: "/", icon: House },
  { label: "Requests", href: "/requests", icon: FileText },
  { label: "Approvals", href: "/approvals", icon: CircleCheck, badge: "8" },
  { label: "Queue", href: "/queue", icon: Truck },
  { label: "Docking", href: "/docking", icon: Building2 },
  { label: "Intraday KPI", href: "/intraday-kpi", icon: ChartNoAxesColumnIncreasing },
  { label: "Notifications", href: "/notifications", icon: Bell, badge: "3", divider: true },
  { label: "Users", href: "/users", icon: UserRound },
  { label: "Reports", href: "/reports", icon: FileText },
  { label: "Settings", href: "/settings", icon: Settings },
];

const statusColors: Record<string, string> = {
  amber: "var(--amber)",
  sky: "var(--sky)",
  green: "var(--green)",
  purple: "var(--purple)",
  blue: "var(--blue)",
  slate: "var(--slate)",
  red: "var(--red)",
};

const dockStatusClass = {
  Available: "dock-available",
  Occupied: "dock-occupied",
  Maintenance: "dock-maintenance",
} as const;

function Sidebar({
  pathname,
  open,
  close,
}: {
  pathname: string;
  open: boolean;
  close: () => void;
}) {
  return (
    <>
      {open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation menu"
          onClick={close}
        />
      )}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="brand">
          <Box size={28} strokeWidth={2.6} className="brand-mark" aria-hidden="true" />
          <span>SOC5 Outbound</span>
          <button
            type="button"
            className="collapse-button"
            aria-label="Close navigation"
            onClick={close}
          >
            <ChevronsLeft size={17} />
          </button>
        </div>
        <nav className="side-nav" id="main-navigation" aria-label="Main navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            const selected = pathname === item.href;
            return (
              <div className={item.divider ? "nav-divider" : undefined} key={item.label}>
                <Link
                  href={item.href}
                  className={`nav-item ${selected ? "nav-item-active" : ""}`}
                  aria-current={selected ? "page" : undefined}
                >
                  <Icon size={18} strokeWidth={2} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.badge && <span className="nav-badge">{item.badge}</span>}
                </Link>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className="connection-dot" />
          <span>All systems operational</span>
        </div>
      </aside>
    </>
  );
}

function Topbar({
  search,
  setSearch,
  theme,
  toggleTheme,
  openMenu,
  menuOpen,
  closeMenu,
  reportingPeriod,
  setReportingPeriod,
}: {
  search: string;
  setSearch: (value: string) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  openMenu: () => void;
  menuOpen: boolean;
  closeMenu: () => void;
  reportingPeriod: ReportingPeriod;
  setReportingPeriod: (period: ReportingPeriod) => void;
}) {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const ThemeIcon = theme === "light" ? Moon : Sun;

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [closeMenu, menuOpen]);

  return (
    <header className="topbar">
      <Button
        variant="ghost"
        size="icon"
        className="mobile-menu-button"
        aria-label="Open navigation menu"
        aria-expanded={menuOpen}
        aria-controls="main-navigation"
        ref={menuButtonRef}
        onClick={openMenu}
      >
        <Menu />
      </Button>
      <label className="search-box">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search requests, trucks, routes, or hubs</span>
        <input
          type="search"
          placeholder="Search requests, trucks, routes, or hubs..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            onClick={() => setSearch("")}
          >
            <X size={14} />
          </button>
        )}
      </label>
      <div className="topbar-actions">
        <label className="date-control">
          <CalendarDays size={15} aria-hidden="true" />
          <span className="sr-only">Reporting date range</span>
          <select
            value={reportingPeriod}
            onChange={(event) => setReportingPeriod(event.target.value as ReportingPeriod)}
            aria-label="Reporting date range"
          >
            <option value="today">Apr 23, 2024 – Apr 23, 2024</option>
            <option value="week">Apr 17, 2024 – Apr 23, 2024</option>
            <option value="month">Apr 1, 2024 – Apr 23, 2024</option>
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <div className="notification-wrap">
          <Button
            variant="ghost"
            size="icon"
            className="topbar-icon-button"
            aria-label="Notifications, 3 unread"
            aria-expanded={notificationsOpen}
            onClick={() => setNotificationsOpen(!notificationsOpen)}
          >
            <Bell />
            <span className="notification-count">3</span>
          </Button>
          {notificationsOpen && (
            <div className="notification-popover" role="status">
              <strong>Notifications</strong>
              <span>3 updates need your attention.</span>
              <button type="button" onClick={() => setNotificationsOpen(false)}>
                Dismiss
              </button>
            </div>
          )}
        </div>
        <span className="topbar-separator" />
        <div className="user-profile" aria-label="Signed in as Daniel Tan, Operations Manager">
          <span className="avatar" aria-hidden="true">DT</span>
          <span className="user-copy">
            <strong>Daniel Tan</strong>
            <small>Operations Manager</small>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="theme-button"
          aria-label="Toggle light and dark theme"
          aria-pressed={theme === "dark"}
          onClick={toggleTheme}
        >
          <ThemeIcon />
        </Button>
      </div>
    </header>
  );
}

function KpiCard({ item }: { item: (typeof kpis)[number] }) {
  const iconByLabel = {
    "Pending Requests": FileText,
    "Approved Today": CircleCheck,
    "Trucks in Queue": Truck,
    "Active Docks": Building2,
    "Intraday Volume": ChartNoAxesColumnIncreasing,
    "SLA Risk": ShieldAlert,
  };
  const Icon = iconByLabel[item.label];
  return (
    <article className={`kpi-card kpi-${item.color}`}>
      <div className="kpi-top">
        <span className="kpi-icon">
          <Icon size={22} strokeWidth={2.3} aria-hidden="true" />
        </span>
        <div className="kpi-value-wrap">
          <strong className="kpi-value">{item.value}</strong>
          <span className="kpi-label">{item.label}</span>
        </div>
      </div>
      <div className="kpi-bottom">
        <div className="kpi-trend">
          <span className="trend-value">
            <span aria-hidden="true">▲</span> {item.change}
          </span>
          <span className="trend-caption">vs. yesterday</span>
        </div>
        <svg className="sparkline" viewBox="0 0 84 32" role="img" aria-label={`${item.label} trend`}>
          <polyline points={item.points} />
        </svg>
      </div>
    </article>
  );
}

function PanelHeading({
  icon: Icon,
  title,
  subtitle,
  actions,
  id,
}: {
  icon: typeof Activity;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="panel-heading">
      <span className="panel-icon">
        <Icon size={19} strokeWidth={2.5} aria-hidden="true" />
      </span>
      <div className="panel-heading-copy">
        <h2 id={id}>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="panel-actions">{actions}</div>}
    </div>
  );
}

function ChartPeriodSelect({
  value,
  onChange,
}: {
  value: ReportingPeriod;
  onChange: (period: ReportingPeriod) => void;
}) {
  return (
    <label className="select-control">
      <span className="sr-only">Chart time period</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as ReportingPeriod)}
        aria-label="Chart time period"
      >
        <option value="today">Today</option>
        <option value="week">This week</option>
        <option value="month">This month</option>
      </select>
      <ChevronDown size={13} aria-hidden="true" />
    </label>
  );
}

function DockStatus() {
  return (
    <section className="panel dock-panel" aria-labelledby="dock-title">
      <div className="dock-panel-header">
        <PanelHeading
          icon={Truck}
          title="Dock & Queue Status"
          subtitle="Real-time dock availability and truck queue"
          id="dock-title"
        />
        <div className="dock-legend" aria-label="Dock status legend">
          <span><i className="legend-dot legend-occupied" />Occupied</span>
          <span><i className="legend-dot legend-available" />Available</span>
          <span><i className="legend-dot legend-maintenance" />Maintenance</span>
        </div>
      </div>
      <div className="dock-grid">
        {docks.map((dock) => (
          <article className="dock-card" key={dock.dock}>
            <h3>{dock.dock}</h3>
            <span className={`dock-pill ${dockStatusClass[dock.status]}`}>
              {dock.status === "Available" ? <Check size={11} /> : null}
              {dock.status === "Occupied" ? <Truck size={11} /> : null}
              {dock.status === "Maintenance" ? <Wrench size={11} /> : null}
              {dock.status}
            </span>
            <div className="dock-truck">
              {dock.status === "Maintenance" ? (
                <Wrench size={15} aria-hidden="true" />
              ) : dock.status === "Available" ? (
                <Truck size={15} aria-hidden="true" />
              ) : (
                <Truck size={15} aria-hidden="true" />
              )}
              <span>{dock.truck}</span>
            </div>
            <p>{dock.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ApprovalPipeline() {
  return (
    <section className="panel pipeline-panel" aria-labelledby="pipeline-title">
      <PanelHeading
        icon={Clock3}
        title="Approval Pipeline"
        subtitle="Current status of outbound requests"
        id="pipeline-title"
      />
      <ul className="pipeline-list">
        {pipeline.map((step) => (
          <li className="pipeline-row" key={step.label}>
            <span
              className="pipeline-dot"
              style={{ backgroundColor: statusColors[step.color] }}
              aria-hidden="true"
            />
            <span className="pipeline-name">{step.label}</span>
            <strong className="pipeline-count">{step.count}</strong>
            <span
              className="pipeline-track"
              role="img"
              aria-label={`${step.percent}% ${step.label.toLowerCase()}`}
            >
              <span
                className="pipeline-fill"
                style={{
                  width: `${step.percent}%`,
                  backgroundColor: statusColors[step.color],
                }}
              />
            </span>
            <span className="pipeline-percent">{step.percent}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentActivity({
  expanded,
  toggleExpanded,
}: {
  expanded: boolean;
  toggleExpanded: () => void;
}) {
  const displayedActivities = expanded
    ? [
        ...activities,
        {
          title: "Request REQ-20240423-015 completed",
          detail: "Outbound to JHB - SIN",
          time: "09:20 AM",
          color: "blue",
        },
      ]
    : activities;
  return (
    <section className="panel activity-panel" aria-labelledby="activity-title">
      <div className="activity-heading">
        <PanelHeading icon={List} title="Recent Activity" id="activity-title" />
        <button type="button" className="text-link" onClick={toggleExpanded}>
          {expanded ? "Show less" : "View all"}
        </button>
      </div>
      <ol className="activity-list">
        {displayedActivities.map((item, index) => (
          <li className="activity-item" key={`${item.title}-${item.time}`}>
            <span className={`activity-marker activity-${item.color}`} aria-hidden="true" />
            {index !== displayedActivities.length - 1 && <span className="activity-line" />}
            <div className="activity-copy">
              <div className="activity-title-row">
                <p>{item.title}</p>
                <time>{item.time}</time>
              </div>
              <span>{item.detail}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LinehaulRequests({
  data,
  search,
  showAll,
  setShowAll,
}: {
  data: LinehaulRequest[];
  search: string;
  showAll: boolean;
  setShowAll: (show: boolean) => void;
}) {
  const [status, setStatus] = useState("All statuses");
  const filteredRequests = useMemo(
    () =>
      data.filter((request) => {
        const matchesSearch =
          !search ||
          Object.values(request).some((value) =>
            value.toLowerCase().includes(search.toLowerCase()),
          );
        return matchesSearch && (status === "All statuses" || request.status === status);
      }),
    [data, search, status],
  );
  return (
    <section className="panel requests-panel" aria-labelledby="requests-title">
      <div className="requests-heading">
        <PanelHeading icon={FileText} title="Latest Linehaul Requests" id="requests-title" />
        <div className="requests-tools">
          <label className="status-filter">
            <span className="sr-only">Filter requests by status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option>All statuses</option>
              {(["Pending", "Approved", "In Queue", "Docked", "Completed", "Rejected"] satisfies RequestStatus[]).map(
                (option) => <option key={option}>{option}</option>,
              )}
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </label>
          <button
            type="button"
            className="text-link"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Show less" : "View all"}
          </button>
        </div>
      </div>
      <RequestsTable data={filteredRequests} showAll={showAll} />
    </section>
  );
}

export default function Dashboard() {
  return <DashboardPage />;
}

export function DashboardPage({ page = "Dashboard" }: { page?: string }) {
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [reportingPeriod, setReportingPeriod] = useState<ReportingPeriod>("today");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("requests");
  const pathname = usePathname();
  const subscribeToTheme = (onChange: () => void) => {
    window.addEventListener("soc5-theme-change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("soc5-theme-change", onChange);
      window.removeEventListener("storage", onChange);
    };
  };
  const getTheme = (): "light" | "dark" =>
    window.localStorage.getItem("soc5-theme") === "dark" ? "dark" : "light";
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getTheme,
    () => "light" as const,
  );

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("soc5-theme");
    document.documentElement.classList.toggle("dark", savedTheme === "dark");
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    window.localStorage.setItem("soc5-theme", nextTheme);
    window.dispatchEvent(new Event("soc5-theme-change"));
  };

  return (
    <div className="app-shell">
      <Sidebar
        pathname={pathname}
        open={menuOpen}
        close={() => setMenuOpen(false)}
      />
      <div className="workspace">
        <Topbar
          search={search}
          setSearch={setSearch}
          theme={theme}
          toggleTheme={toggleTheme}
          openMenu={() => setMenuOpen(true)}
          menuOpen={menuOpen}
          closeMenu={() => setMenuOpen(false)}
          reportingPeriod={reportingPeriod}
          setReportingPeriod={setReportingPeriod}
        />
        <main className="dashboard-main">
          {page === "Dashboard" ? (
            <>
          <div className="page-heading">
            <div>
              <h1>Logistics Control Center</h1>
              <p>Real-time outbound monitoring and linehaul operations.</p>
            </div>
            <div className="live-status">
              <span><i />Live Data</span>
              <small>Last updated today, 10:24 AM</small>
            </div>
          </div>
          <section className="kpi-grid" aria-label="Key performance indicators">
            {kpis.map((item) => <KpiCard item={item} key={item.label} />)}
          </section>

          <div className="dashboard-grid">
            <div className="dashboard-primary">
              <div className="charts-row">
                <section className="panel chart-panel flow-panel" aria-labelledby="flow-title">
                  <PanelHeading
                    icon={Activity}
                    title="Outbound Request Flow"
                    subtitle="Number of requests across all hubs"
                    id="flow-title"
                    actions={
                      <>
                        <label className="select-control">
                          <span className="sr-only">Chart metric</span>
                          <select
                            value={chartMetric}
                            onChange={(event) => setChartMetric(event.target.value as ChartMetric)}
                            aria-label="Chart metric"
                          >
                            <option value="requests">Requests</option>
                            <option value="trucks">Trucks</option>
                          </select>
                          <ChevronDown size={13} aria-hidden="true" />
                        </label>
                        <ChartPeriodSelect value={reportingPeriod} onChange={setReportingPeriod} />
                      </>
                    }
                  />
                  <div className="chart-area">
                    <RequestFlowChart metric={chartMetric} period={reportingPeriod} />
                  </div>
                </section>
                <section className="panel chart-panel volume-panel" aria-labelledby="volume-title">
                  <PanelHeading
                    icon={ChartNoAxesColumnIncreasing}
                    title="Hourly Outbound Volume"
                    subtitle="Trucks dispatched per hour"
                    id="volume-title"
                    actions={<ChartPeriodSelect value={reportingPeriod} onChange={setReportingPeriod} />}
                  />
                  <div className="chart-area">
                    <HourlyVolumeChart period={reportingPeriod} />
                  </div>
                </section>
              </div>
              <DockStatus />
              <LinehaulRequests
                data={requests}
                search={search}
                showAll={showAll}
                setShowAll={setShowAll}
              />
            </div>
            <aside className="dashboard-secondary" aria-label="Operations overview">
              <ApprovalPipeline />
              <RecentActivity
                expanded={activityExpanded}
                toggleExpanded={() => setActivityExpanded(!activityExpanded)}
              />
            </aside>
          </div>
            </>
          ) : (
            <ModulePage page={page} />
          )}
        </main>
      </div>
    </div>
  );
}
