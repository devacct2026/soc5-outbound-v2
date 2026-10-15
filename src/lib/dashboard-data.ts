export const kpis = [
  {
    label: "Pending Requests",
    value: "24",
    change: "+20%",
    direction: "up",
    color: "blue",
    points: "2,27 12,20 22,22 32,16 42,22 52,11 62,17 72,6 82,1",
  },
  {
    label: "Approved Today",
    value: "56",
    change: "+12%",
    direction: "up",
    color: "green",
    points: "2,27 12,21 22,16 32,20 42,13 52,17 62,8 72,18 82,5",
  },
  {
    label: "Trucks in Queue",
    value: "18",
    change: "+6%",
    direction: "up",
    color: "blue",
    points: "2,20 12,13 22,18 32,8 42,11 52,5 62,10 72,3 82,0",
  },
  {
    label: "Active Docks",
    value: "6 / 8",
    change: "+25%",
    direction: "up",
    color: "purple",
    points: "2,27 12,18 22,21 32,12 42,8 52,12 62,5 72,8 82,0",
  },
  {
    label: "Intraday Volume",
    value: "428",
    change: "+18%",
    direction: "up",
    color: "sky",
    points: "2,25 12,18 22,20 32,16 42,19 52,10 62,15 72,5 82,0",
  },
  {
    label: "SLA Risk",
    value: "12%",
    change: "+4%",
    direction: "up",
    color: "red",
    points: "2,19 12,13 22,8 32,14 42,7 52,14 62,5 72,11 82,4",
  },
] as const;

export const requestFlow = [
  { hour: "00:00", requests: 14 },
  { hour: "01:00", requests: 16 },
  { hour: "02:00", requests: 20 },
  { hour: "03:00", requests: 23 },
  { hour: "04:00", requests: 31 },
  { hour: "05:00", requests: 31 },
  { hour: "06:00", requests: 37 },
  { hour: "07:00", requests: 32 },
  { hour: "08:00", requests: 33 },
  { hour: "09:00", requests: 26 },
  { hour: "10:00", requests: 24 },
  { hour: "11:00", requests: 34 },
  { hour: "12:00", requests: 42 },
  { hour: "13:00", requests: 50 },
  { hour: "14:00", requests: 46 },
  { hour: "15:00", requests: 45 },
  { hour: "16:00", requests: 49 },
  { hour: "17:00", requests: 56 },
  { hour: "18:00", requests: 50 },
  { hour: "19:00", requests: 38 },
  { hour: "20:00", requests: 39 },
  { hour: "21:00", requests: 38 },
  { hour: "22:00", requests: 29 },
  { hour: "23:00", requests: 23 },
];

export const hourlyVolume = [
  { hour: "00", trucks: 4 },
  { hour: "01", trucks: 6 },
  { hour: "02", trucks: 10 },
  { hour: "03", trucks: 10 },
  { hour: "04", trucks: 8 },
  { hour: "05", trucks: 12 },
  { hour: "06", trucks: 9 },
  { hour: "07", trucks: 13 },
  { hour: "08", trucks: 16 },
  { hour: "09", trucks: 18 },
  { hour: "10", trucks: 23 },
  { hour: "11", trucks: 29 },
  { hour: "12", trucks: 24 },
  { hour: "13", trucks: 30 },
  { hour: "14", trucks: 21 },
  { hour: "15", trucks: 18 },
  { hour: "16", trucks: 13 },
  { hour: "17", trucks: 9 },
  { hour: "18", trucks: 12 },
  { hour: "19", trucks: 10 },
  { hour: "20", trucks: 9 },
  { hour: "21", trucks: 5 },
];

export const pipeline = [
  { label: "Pending", count: 24, percent: 28, color: "amber" },
  { label: "In Review", count: 18, percent: 21, color: "sky" },
  { label: "Approved", count: 56, percent: 66, color: "green" },
  { label: "In Queue", count: 18, percent: 21, color: "purple" },
  { label: "Docked", count: 12, percent: 14, color: "blue" },
  { label: "Completed", count: 72, percent: 85, color: "slate" },
  { label: "Rejected", count: 6, percent: 7, color: "red" },
] as const;

export const docks = [
  { dock: "Dock 1", status: "Available", truck: "—", detail: "No truck" },
  { dock: "Dock 2", status: "Occupied", truck: "WXY 1234", detail: "ETA 12 min" },
  { dock: "Dock 3", status: "Occupied", truck: "ABC 5678", detail: "ETA 28 min" },
  { dock: "Dock 4", status: "Available", truck: "—", detail: "No truck" },
  { dock: "Dock 5", status: "Occupied", truck: "DEF 9012", detail: "ETA 10 min" },
  { dock: "Dock 6", status: "Occupied", truck: "GHI 3456", detail: "ETA 25 min" },
  { dock: "Dock 7", status: "Available", truck: "—", detail: "No truck" },
  { dock: "Dock 8", status: "Maintenance", truck: "—", detail: "Until 14:00" },
] as const;

export type RequestStatus =
  | "Pending"
  | "Approved"
  | "In Queue"
  | "Docked"
  | "Completed"
  | "Rejected";

export type LinehaulRequest = {
  id: string;
  hub: string;
  route: string;
  plate: string;
  requestedBy: string;
  status: RequestStatus;
  eta: string;
};

export const requests: LinehaulRequest[] = [
  {
    id: "REQ-20240423-018",
    hub: "Singapore DC",
    route: "SIN → KUL",
    plate: "WXY 1234",
    requestedBy: "Sarah Lim",
    status: "Pending",
    eta: "12:30 PM",
  },
  {
    id: "REQ-20240423-017",
    hub: "Kuala Lumpur",
    route: "KUL → PEN",
    plate: "ABC 5678",
    requestedBy: "Ahmad Rizal",
    status: "Approved",
    eta: "01:15 PM",
  },
  {
    id: "REQ-20240423-016",
    hub: "Singapore DC",
    route: "SIN → JHB",
    plate: "DEF 9012",
    requestedBy: "Daniel Tan",
    status: "In Queue",
    eta: "02:10 PM",
  },
  {
    id: "REQ-20240423-015",
    hub: "Johor Bahru",
    route: "JHB → SIN",
    plate: "GHI 3456",
    requestedBy: "Priya Nair",
    status: "Docked",
    eta: "11:40 AM",
  },
  {
    id: "REQ-20240423-014",
    hub: "Singapore DC",
    route: "SIN → BKK",
    plate: "JKL 7788",
    requestedBy: "Marcus Lee",
    status: "Completed",
    eta: "09:20 AM",
  },
  {
    id: "REQ-20240423-013",
    hub: "Kuala Lumpur",
    route: "KUL → SIN",
    plate: "MNO 1122",
    requestedBy: "Chen Wei",
    status: "Rejected",
    eta: "—",
  },
  {
    id: "REQ-20240423-012",
    hub: "Penang",
    route: "PEN → KUL",
    plate: "PQR 4455",
    requestedBy: "Nur Aisyah",
    status: "Approved",
    eta: "03:00 PM",
  },
  {
    id: "REQ-20240423-011",
    hub: "Singapore DC",
    route: "SIN → JHB",
    plate: "STU 9988",
    requestedBy: "James Wong",
    status: "Pending",
    eta: "03:45 PM",
  },
];

export const activities = [
  {
    title: "Truck WXY 1234 docked at Dock 2",
    detail: "Outbound to SIN - KUL",
    time: "10:18 AM",
    color: "green",
  },
  {
    title: "Request REQ-20240423-018 approved",
    detail: "By Sarah Lim",
    time: "10:12 AM",
    color: "green",
  },
  {
    title: "Truck DEF 9012 arrived at gate",
    detail: "Queued for Dock 5",
    time: "10:05 AM",
    color: "blue",
  },
  {
    title: "Request REQ-20240423-016 rejected",
    detail: "Route capacity exceeded",
    time: "09:48 AM",
    color: "red",
  },
  {
    title: "Dock 7 marked as available",
    detail: "Previous truck completed loading",
    time: "09:32 AM",
    color: "green",
  },
] as const;
