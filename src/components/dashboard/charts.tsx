"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { hourlyVolume, requestFlow } from "@/lib/dashboard-data";

export type ReportingPeriod = "today" | "week" | "month";
export type ChartMetric = "requests" | "trucks";

const axisStyle = {
  fill: "var(--muted-foreground)",
  fontSize: 10,
};

function getFlowData(metric: ChartMetric, period: ReportingPeriod) {
  const data =
    metric === "requests"
      ? requestFlow.map(({ hour, requests }) => ({ hour, value: requests }))
      : hourlyVolume.map(({ hour, trucks }) => ({ hour: `${hour}:00`, value: trucks }));
  const visibleCount = period === "today" ? data.length : period === "week" ? 12 : 6;
  return data.slice(0, visibleCount);
}

export function RequestFlowChart({
  metric,
  period,
}: {
  metric: ChartMetric;
  period: ReportingPeriod;
}) {
  const data = getFlowData(metric, period);
  const maxValue = Math.ceil(Math.max(...data.map((point) => point.value)) / 10) * 10;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: 5, left: -15, bottom: 0 }}>
        <defs>
          <linearGradient id="requestFlowFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2f80ed" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#2f80ed" stopOpacity={0.015} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" vertical />
        <XAxis
          dataKey="hour"
          interval={3}
          tickLine={false}
          axisLine={false}
          tick={axisStyle}
          tickMargin={8}
        />
        <YAxis
          domain={[0, maxValue]}
          tickCount={5}
          tickLine={false}
          axisLine={false}
          tick={axisStyle}
          tickMargin={6}
        />
        <Tooltip
          cursor={{ stroke: "#2f80ed", strokeDasharray: "3 3" }}
          contentStyle={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--card)",
            color: "var(--foreground)",
            fontSize: 11,
            boxShadow: "0 5px 16px rgb(15 23 42 / 10%)",
          }}
          formatter={(value) => [
            `${value} ${metric}`,
            metric === "requests" ? "Requests" : "Trucks",
          ]}
          labelFormatter={(label) => label}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="#1677f8"
          strokeWidth={2}
          fill="url(#requestFlowFill)"
          activeDot={{ r: 4, strokeWidth: 2, fill: "#1677f8", stroke: "white" }}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function HourlyVolumeChart({ period }: { period: ReportingPeriod }) {
  const visibleCount = period === "today" ? hourlyVolume.length : period === "week" ? 12 : 6;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={hourlyVolume.slice(0, visibleCount)} margin={{ top: 6, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical />
        <XAxis
          dataKey="hour"
          interval={1}
          tickLine={false}
          axisLine={false}
          tick={axisStyle}
          tickMargin={8}
        />
        <YAxis
          domain={[0, 40]}
          ticks={[0, 10, 20, 30, 40]}
          tickLine={false}
          axisLine={false}
          tick={axisStyle}
          tickMargin={6}
        />
        <Tooltip
          cursor={{ fill: "rgba(22, 119, 248, .07)" }}
          contentStyle={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--card)",
            color: "var(--foreground)",
            fontSize: 11,
            boxShadow: "0 5px 16px rgb(15 23 42 / 10%)",
          }}
          formatter={(value) => [`${value} trucks`, "Trucks"]}
          labelFormatter={(label) => `${label}:00`}
        />
        <Bar dataKey="trucks" fill="#4a94f6" radius={[2, 2, 0, 0]} maxBarSize={12} />
      </BarChart>
    </ResponsiveContainer>
  );
}
