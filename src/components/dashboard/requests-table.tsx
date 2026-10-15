"use client";

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
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
  const columns = useMemo<ColumnDef<LinehaulRequest>[]>(
    () => [
      { accessorKey: "id", header: "Request ID" },
      { accessorKey: "hub", header: "Hub" },
      { accessorKey: "route", header: "Route" },
      { accessorKey: "plate", header: "Plate No." },
      { accessorKey: "requestedBy", header: "Requested By" },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ getValue }) => {
          const status = getValue<RequestStatus>();
          return (
            <span className={`status-pill ${statusClass[status]}`}>
              <span className="status-dot" />
              {status}
            </span>
          );
        },
      },
      { accessorKey: "eta", header: "ETA" },
      {
        id: "action",
        header: "Action",
        cell: ({ row }) => (
          <button
            type="button"
            className="table-action"
            aria-label={`View request ${row.original.id}`}
            title="View request"
            onClick={() => setSelectedRequest(row.original)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        ),
      },
    ],
    [setSelectedRequest],
  );
  const visibleData = showAll ? data : data.slice(0, 6);
  // TanStack's instance stays within this component and is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: visibleData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <div className="table-scroll">
        <table className="requests-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} scope="col">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty-table">
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
