/**
 * @NApiVersion 2.0
 * @NScriptType UserEventScript
 *
 * SR_UE_AddApproveButton.js
 *
 * Implements FR-01 (Approve/Reject Button Visibility Logic) from
 * "TRD - Stock Transfer Request Approval & Transfer Order Automation" v1.0.0.
 *
 * Applies To : customrecord_stock_request
 * Trigger    : beforeLoad, context type VIEW or EDIT
 *
 * Visibility rules (all must be true, applies to BOTH the Approve and
 * Reject buttons - eligibility is identical for both actions):
 *   1. custrecord_sr_status = Pending Approval
 *   2. Current user role = Administrator (id 3) OR the current employee's
 *      standard 'location' field = this Stock Transfer Request's
 *      custrecord_sr_fulfilling_location
 *   3. The Stock Transfer Request has at least one customrecord_stock_request_lines
 *      record associated with it
 *
 * *** SCOPE CHANGE (Reject action) ***
 * A Reject button is now rendered alongside Approve, under the same
 * visibility rules. Rejecting sets status to Rejected and creates NO
 * Transfer Order (see SR_SL_ProcessApproval.js).
 *
 * NOTE - this is the "cosmetic" UI-level check only. Per the TRD Security
 * Model (defense in depth), authorization is independently re-verified,
 * server-side, in SR_SL_ProcessApproval - the buttons being hidden here
 * must never be relied on as the sole access control.
 *
 * Prerequisite: customrecord_stock_request and customrecord_stock_request_lines
 * must exist in the account before this script is deployed (see TRD FR-01
 * Dependency).
 */
define([
    'N/runtime',
    'N/search',
    'N/log',
    '../lib/Partridge_STR_Constants'
], function (runtime, search, log, SR) {

    /**
     * Looks up the internal ID of the current user's Employee 'location'
     * field. Returns null if unset or if the lookup fails.
     * @param {number} employeeId
     * @returns {string|null}
     */
    function getEmployeeLocationId(employeeId) {
        try {
            var result = search.lookupFields({
                type: search.Type.EMPLOYEE,
                id: employeeId,
                columns: [SR.FIELD.EMPLOYEE.LOCATION]
            });
            var locationField = result[SR.FIELD.EMPLOYEE.LOCATION];
            // List/Record fields come back from lookupFields as an array
            // of {value, text} objects, even for a single-select field.
            if (Array.isArray(locationField) && locationField.length > 0) {
                return locationField[0].value;
            }
            return null;
        } catch (e) {
            log.error({ title: 'SR_UE_AddApproveButton - employee location lookup failed', details: e });
            return null;
        }
    }

    /**
     * Role = Administrator, OR current employee's Location = the Stock
     * Transfer Request's Fulfilling Location. Shared eligibility rule for
     * both Approve and Reject.
     * @param {string} fulfillingLocationId
     * @returns {boolean}
     */
    function isCurrentUserAuthorized(fulfillingLocationId) {
        var currentUser = runtime.getCurrentUser();
        if (parseInt(currentUser.role, 10) === SR.ROLE.ADMINISTRATOR) {
            return true;
        }

        if (!fulfillingLocationId) {
            return false;
        }

        var employeeLocationId = getEmployeeLocationId(currentUser.id);
        return !!employeeLocationId && String(employeeLocationId) === String(fulfillingLocationId);
    }

    /**
     * At least one customrecord_stock_request_lines record points at this
     * Stock Transfer Request.
     * @param {number} stockRequestId
     * @returns {boolean}
     */
    function hasAtLeastOneLine(stockRequestId) {
        var lineSearch = search.create({
            type: SR.RECORD.STOCK_REQUEST_LINES,
            filters: [
                [SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST, 'anyof', stockRequestId]
            ],
            columns: ['internalid']
        });

        var resultSet = lineSearch.run().getRange({ start: 0, end: 1 });
        return resultSet.length > 0;
    }

    /**
     * @param {UserEventContext} context
     */
    function beforeLoad(context) {
        try {
            if (context.type !== context.UserEventType.VIEW &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var rec = context.newRecord;
            var form = context.form;

            var statusValue = rec.getValue({ fieldId: SR.FIELD.STOCK_REQUEST.STATUS });
            if (parseInt(statusValue, 10) !== SR.STATUS.PENDING_APPROVAL) {
                return; // FR-01: only render when status = Pending Approval
            }

            var fulfillingLocationId = rec.getValue({ fieldId: SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION });

            if (!isCurrentUserAuthorized(fulfillingLocationId)) {
                return; // FR-01: role = Administrator OR employee.location = Fulfilling Location
            }

            if (!hasAtLeastOneLine(rec.id)) {
                return; // FR-01: suppress if zero Stock Transfer Request Lines
            }

            form.clientScriptModulePath = SR.UE_SCRIPT.CLIENT_SCRIPT_FILE_NAME;

            form.addButton({
                id: SR.MISC.APPROVE_BUTTON_ID,
                label: SR.MISC.APPROVE_BUTTON_LABEL,
                functionName: SR.MISC.APPROVE_FUNCTION_NAME + '(' + rec.id + ')'
            });

            form.addButton({
                id: SR.MISC.REJECT_BUTTON_ID,
                label: SR.MISC.REJECT_BUTTON_LABEL,
                functionName: SR.MISC.REJECT_FUNCTION_NAME + '(' + rec.id + ')'
            });
        } catch (e) {
            // Fail closed: any unexpected error means the buttons are simply
            // not shown, never that they're shown incorrectly.
            log.error({
                title: 'SR_UE_AddApproveButton - beforeLoad error',
                details: e
            });
        }
    }

    return {
        beforeLoad: beforeLoad
    };
});