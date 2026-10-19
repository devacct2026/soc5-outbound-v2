// Wire format for requests (snake_case, contract in docs/backend/04-api-contracts.md).
import type { RequestRecord } from "../domain/requests/lifecycle.ts";
import { nextActionRole } from "../domain/requests/lifecycle.ts";
import { displayStatus } from "../domain/permissions.ts";
import type { Actor } from "../domain/requests/workflow.ts";

export function toApiRequest(r: RequestRecord, viewer: Actor) {
  return {
    id: r.id,
    request_timestamp: r.requestTimestamp,
    cluster_id: r.clusterId,
    cluster: r.cluster,
    region: r.region,
    dock_no: r.dockNo,
    backlogs: r.backlogs,
    backlogs_timestamp: r.backlogsTimestamp,
    truck_size: r.truckSize,
    truck_type: r.truckType,
    created_by: r.createdBy,
    status: r.status,
    display_status: displayStatus(viewer.role, r.status),
    approval_status: r.approvalStatus,
    approval_version: r.approvalVersion,
    next_action_role: nextActionRole(r),
    rejection_disposition: r.rejectionDisposition,
    rejection_return_role: r.rejectionReturnRole,
    rejection_remarks: r.rejectionRemarks,
    cancellation_remarks: r.cancellationRemarks,
    plate_number: r.plateNumber,
    provide_time: r.provideTime,
    driver_id: r.driverId,
    driver_assigned_at: r.driverAssignedAt,
    linehaul_trip_no: r.linehaulTripNo,
    linehaul_trip_at: r.linehaulTripAt,
    docked_at: r.dockedAt,
    approved_at: r.approvedAt,
    created_at: r.createdAt,
    row_version: r.rowVersion,
  };
}
