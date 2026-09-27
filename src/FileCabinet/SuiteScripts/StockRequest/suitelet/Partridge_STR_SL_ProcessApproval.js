/**
 * @NApiVersion 2.0
 * @NScriptType Suitelet
 *
 * SR_SL_ProcessApproval.js
 *
 * Implements FR-03 (Server-Side Approval/Rejection Processing) from
 * "TRD - Stock Transfer Request Approval & Transfer Order Automation" v1.0.0.
 *
 * Method   : POST only (GET/others rejected)
 * Input    : JSON body { stockRequestId: <id>, action: 'approve' | 'reject' }
 * Output   : JSON body { success: boolean, transferOrderId?: number, message?: string }
 *
 * *** SCOPE CHANGE (location-based approval) ***
 * Authorization is location-based: Administrator, OR any active Employee
 * whose standard 'location' field equals THIS Stock Transfer Request's
 * Fulfilling Location, may approve OR reject. Because this depends on
 * data from the specific record being acted on, the record is loaded
 * BEFORE the authorization check runs.
 *
 * *** SCOPE CHANGE (Reject action) ***
 * When action = 'reject': status is set to Rejected. NO field/line
 * validation runs (BR-05 through BR-08 only apply to approval), and NO
 * Transfer Order is created. This lets an incomplete or invalid request
 * be rejected without first having to be "fixed" to pass approval
 * validation.
 *
 * *** SCOPE CHANGE (Intercompany Transfer Order) ***
 * Approval now creates an Intercompany Transfer Order
 * (record.Type.INTER_COMPANY_TRANSFER_ORDER), not a plain Transfer
 * Order. This adds a subsidiary validation step (From/To Subsidiary
 * must both be set on the header) and, per line, an Inventory Detail
 * subrecord assignment when custrecord_srl_lot_serial_number is set.
 * The JSON response key is still named "transferOrderId" for client
 * compatibility, even though it now holds the ITO's internal ID.
 *
 * Deployment requirements (TRD Security Model):
 *   - Available without login: No
 *   - Deployment audience restricted as tightly as feasible
 *
 * This is the enforced authorization boundary. It never trusts the client:
 * every check performed client-side in SR_CS_ApproveHandler.js /
 * SR_UE_AddApproveButton.js is repeated here independently, including
 * re-checking status = Pending Approval to guard against double-submission
 * / race conditions (Test Case 14) - this applies to reject just as much
 * as approve, so a request cannot be rejected twice or approved-then-rejected.
 */
define([
    'N/record',
    'N/search',
    'N/runtime',
    'N/log',
    '../lib/Partridge_STR_Constants',
    '../lib/Partridge_STR_Notifications'
], function (record, search, runtime, log, SR, notifications) {

    /**
     * Looks up the internal ID of an Employee's 'location' field. Returns
     * null if unset or if the lookup fails.
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
            if (Array.isArray(locationField) && locationField.length > 0) {
                return locationField[0].value;
            }
            return null;
        } catch (e) {
            log.error({ title: 'SR_SL_ProcessApproval - employee location lookup failed', details: e });
            return null;
        }
    }

    /**
     * Role = Administrator, OR current employee's Location = the Stock
     * Transfer Request's Fulfilling Location. Shared rule for both
     * approve and reject.
     * Duplicated intentionally from SR_UE_AddApproveButton.js: this check
     * must stand on its own and never depend on the UE script having run.
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
     * @param {number} stockRequestId
     * @returns {Array<{item: string, quantity: string, lotSerialNumber: string|null}>}
     */
    function getStockRequestLines(stockRequestId) {
        var lines = [];
        var lineSearch = search.create({
            type: SR.RECORD.STOCK_REQUEST_LINES,
            filters: [
                [SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST, 'anyof', stockRequestId]
            ],
            columns: [
                SR.FIELD.STOCK_REQUEST_LINES.ITEM,
                SR.FIELD.STOCK_REQUEST_LINES.QUANTITY,
                SR.FIELD.STOCK_REQUEST_LINES.LOT_SERIAL_NUMBER
            ]
        });

        lineSearch.run().each(function (resultRow) {
            lines.push({
                item: resultRow.getValue(SR.FIELD.STOCK_REQUEST_LINES.ITEM),
                quantity: resultRow.getValue(SR.FIELD.STOCK_REQUEST_LINES.QUANTITY),
                // Internal ID of the Inventory Number record, or '' if unset -
                // LOT_SERIAL_NUMBER is a List/Record field, so getValue()
                // already returns the internal ID, not text.
                lotSerialNumber: resultRow.getValue(SR.FIELD.STOCK_REQUEST_LINES.LOT_SERIAL_NUMBER) || null
            });
            return true; // continue iterating all lines
        });

        return lines;
    }

    /**
     * Creates an Intercompany Transfer Order (record.Type.INTER_COMPANY_TRANSFER_ORDER,
     * internal ID 'intercompanytransferorder') - NOT a plain Transfer Order.
     * This record type requires explicit source/destination Subsidiary
     * values in addition to source/destination Location.
     *
     * For any line carrying a Lot/Serial Number (an Inventory Number
     * record reference), an Inventory Detail subrecord is attached to
     * that line with an 'issueinventorynumber' assignment - this is how
     * NetSuite records WHICH specific lot/serial units are being moved,
     * as distinct from the plain quantity on the line itself.
     *
     * @param {Object} params
     * @param {string} params.fulfillingLocation
     * @param {string} params.requestingLocation
     * @param {string} params.fromSubsidiary - subsidiary of the Fulfilling Location (source)
     * @param {string} params.toSubsidiary - subsidiary of the Requesting Location (destination)
     * @param {Array<{item: string, quantity: string, lotSerialNumber: string|null}>} params.lines
     * @param {number} params.stockRequestId
     * @returns {number} newly created Intercompany Transfer Order internal ID
     */
    function createIntercompanyTransferOrder(params) {
        var ito = record.create({
            type: record.Type.INTER_COMPANY_TRANSFER_ORDER,
            isDynamic: true
        });

        ito.setValue({ fieldId: 'subsidiary', value: params.fromSubsidiary });
        ito.setValue({ fieldId: 'tosubsidiary', value: params.toSubsidiary });
        ito.setValue({ fieldId: 'location', value: params.fulfillingLocation });
        ito.setValue({ fieldId: 'transferlocation', value: params.requestingLocation });
        ito.setValue({ fieldId: 'trandate', value: new Date() });
        ito.setValue({
            fieldId: 'memo',
            value: 'Auto-created from Stock Transfer Request #' + params.stockRequestId
        });

        for (var i = 0; i < params.lines.length; i++) {
            var line = params.lines[i];
            var lineQuantity = parseFloat(line.quantity);

            ito.selectNewLine({ sublistId: 'item' });
            ito.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: line.item });
            ito.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: lineQuantity });

            if (line.lotSerialNumber) {
                var inventoryDetail = ito.getCurrentSublistSubrecord({
                    sublistId: 'item',
                    fieldId: 'inventorydetail'
                });

                inventoryDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'issueinventorynumber',
                    value: line.lotSerialNumber
                });
                inventoryDetail.setCurrentSublistValue({
                    sublistId: 'inventoryassignment',
                    fieldId: 'quantity',
                    value: lineQuantity
                });
                inventoryDetail.commitLine({ sublistId: 'inventoryassignment' });
            }

            ito.commitLine({ sublistId: 'item' });
        }

        return ito.save();
    }

    /**
     * Approve branch: full field/line validation (BR-05 through BR-08),
     * Intercompany Transfer Order creation (BR-09), status -> Approved (BR-10).
     * @param {Record} stockRequest - already-loaded record
     * @param {number} stockRequestId
     * @param {string} requestingLocation
     * @param {string} fulfillingLocation
     * @returns {{success: boolean, transferOrderId?: number, message?: string}}
     */
    function approveRequest(stockRequest, stockRequestId, requestingLocation, fulfillingLocation) {
        // --- Field-level validation (BR-05, BR-06) ---
        if (!requestingLocation || !fulfillingLocation) {
            return {
                success: false,
                message: 'Both Requesting Location and Fulfilling Location must be set.'
            };
        }
        if (String(requestingLocation) === String(fulfillingLocation)) {
            return {
                success: false,
                message: 'Requesting Location and Fulfilling Location cannot be the same.'
            };
        }

        // --- Subsidiary validation (added for Intercompany Transfer Order -
        // --- required by that record type, not previously needed for a
        // --- plain Transfer Order) ---
        var fromSubsidiary = stockRequest.getValue({ fieldId: SR.FIELD.STOCK_REQUEST.FROM_SUBSIDIARY });
        var toSubsidiary = stockRequest.getValue({ fieldId: SR.FIELD.STOCK_REQUEST.TO_SUBSIDIARY });
        if (!fromSubsidiary || !toSubsidiary) {
            return {
                success: false,
                message: 'Both From Subsidiary and To Subsidiary must be set before this request can be approved.'
            };
        }

        // --- Line-level validation (BR-07, BR-08) ---
        var lines = getStockRequestLines(stockRequestId);
        if (lines.length === 0) {
            return { success: false, message: 'This Stock Transfer Request has no line items.' };
        }
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i].item || !lines[i].quantity || parseFloat(lines[i].quantity) <= 0) {
                return {
                    success: false,
                    message: 'Every line must have an Item and a quantity greater than zero.'
                };
            }
        }

        // --- Create Intercompany Transfer Order (BR-09) ---
        var intercompanyTransferOrderId;
        try {
            intercompanyTransferOrderId = createIntercompanyTransferOrder({
                fulfillingLocation: fulfillingLocation,
                requestingLocation: requestingLocation,
                fromSubsidiary: fromSubsidiary,
                toSubsidiary: toSubsidiary,
                lines: lines,
                stockRequestId: stockRequestId
            });
        } catch (e) {
            log.error({ title: 'SR_SL_ProcessApproval - Intercompany Transfer Order creation failed', details: e });
            return { success: false, message: 'Intercompany Transfer Order could not be created: ' + e.message };
        }

        // --- Update Stock Transfer Request status only after successful ITO save (BR-10) ---
        var approverEmployeeId = runtime.getCurrentUser().id;
        var notificationRecipients;
        try {
            notificationRecipients = notifications.getRequestRecipients(stockRequestId, approverEmployeeId);
        } catch (notificationLookupError) {
            log.error({
                title: 'SR_SL_ProcessApproval - approval notification recipients unavailable',
                details: 'Stock Transfer Request ' + stockRequestId + ': ' + notificationLookupError.message
            });
        }

        try {
            record.submitFields({
                type: SR.RECORD.STOCK_REQUEST,
                id: stockRequestId,
                values: (function () {
                    var values = {};
                    values[SR.FIELD.STOCK_REQUEST.STATUS] = SR.STATUS.APPROVED;
                    values[SR.FIELD.STOCK_REQUEST.APPROVED_BY] = approverEmployeeId;
                    values[SR.FIELD.STOCK_REQUEST.DATE_APPROVED] = new Date();
                    if (SR.FIELD.STOCK_REQUEST.TRANSFER_ORDER) {
                        values[SR.FIELD.STOCK_REQUEST.TRANSFER_ORDER] = intercompanyTransferOrderId;
                    }
                    return values;
                })()
            });
        } catch (e) {
            // ITO was created but status update failed - surface clearly so this is not silently lost.
            log.error({
                title: 'SR_SL_ProcessApproval - status update failed after ITO creation',
                details: 'Stock Transfer Request ' + stockRequestId + ' -> Intercompany Transfer Order ' +
                    intercompanyTransferOrderId + ': ' + e.message
            });
            return {
                success: false,
                message: 'Intercompany Transfer Order ' + intercompanyTransferOrderId + ' was created, but the ' +
                    'Stock Transfer Request status could not be updated. Please contact your administrator.'
            };
        }

        var notificationMessage = '';
        try {
            notifications.sendStockRequestNotification(
                stockRequestId,
                'approved',
                approverEmployeeId,
                notificationRecipients
            );
        } catch (notificationError) {
            log.error({
                title: 'SR_SL_ProcessApproval - approval notification failed',
                details: 'Stock Transfer Request ' + stockRequestId + ': ' + notificationError.message
            });
            notificationMessage = ' The request was approved, but the notification email could not be sent.';
        }

        log.audit({
            title: 'SR_SL_ProcessApproval - approved',
            details: 'Stock Transfer Request ' + stockRequestId + ' approved by user ' +
                runtime.getCurrentUser().id + '; Intercompany Transfer Order ' + intercompanyTransferOrderId + ' created.'
        });

        return {
            success: true,
            transferOrderId: intercompanyTransferOrderId, // key name kept for client compatibility - see note below
            message: 'Stock Transfer Request approved and Intercompany Transfer Order created.' + notificationMessage
        };
    }

    /**
     * Reject branch: NO field/line validation, NO Transfer Order created.
     * Status -> Rejected only.
     * @param {number} stockRequestId
     * @returns {{success: boolean, message?: string}}
     */
    function rejectRequest(stockRequestId) {
        var approverEmployeeId = runtime.getCurrentUser().id;
        var notificationRecipients;
        try {
            notificationRecipients = notifications.getRequestRecipients(stockRequestId, approverEmployeeId);
        } catch (notificationLookupError) {
            log.error({
                title: 'SR_SL_ProcessApproval - rejection notification recipients unavailable',
                details: 'Stock Transfer Request ' + stockRequestId + ': ' + notificationLookupError.message
            });
        }

        try {
            record.submitFields({
                type: SR.RECORD.STOCK_REQUEST,
                id: stockRequestId,
                values: (function () {
                    var values = {};
                    values[SR.FIELD.STOCK_REQUEST.STATUS] = SR.STATUS.REJECTED;
                    values[SR.FIELD.STOCK_REQUEST.APPROVED_BY] = approverEmployeeId;
                    values[SR.FIELD.STOCK_REQUEST.DATE_APPROVED] = new Date();
                    return values;
                })()
            });
        } catch (e) {
            log.error({
                title: 'SR_SL_ProcessApproval - status update failed on reject',
                details: 'Stock Transfer Request ' + stockRequestId + ': ' + e.message
            });
            return {
                success: false,
                message: 'The Stock Transfer Request could not be rejected. Please contact your administrator.'
            };
        }

        var notificationMessage = '';
        try {
            notifications.sendStockRequestNotification(
                stockRequestId,
                'rejected',
                approverEmployeeId,
                notificationRecipients
            );
        } catch (notificationError) {
            log.error({
                title: 'SR_SL_ProcessApproval - rejection notification failed',
                details: 'Stock Transfer Request ' + stockRequestId + ': ' + notificationError.message
            });
            notificationMessage = ' The request was rejected, but the notification email could not be sent.';
        }

        log.audit({
            title: 'SR_SL_ProcessApproval - rejected',
            details: 'Stock Transfer Request ' + stockRequestId + ' rejected by user ' +
                runtime.getCurrentUser().id + '.'
        });

        return {
            success: true,
            message: 'Stock Transfer Request rejected. No Transfer Order was created.' + notificationMessage
        };
    }

    /**
     * @param {ServerRequest} request
     * @returns {{success: boolean, transferOrderId?: number, message?: string}}
     */
    function processApproval(request) {
        var body;
        try {
            body = JSON.parse(request.body);
        } catch (e) {
            return { success: false, message: 'Malformed request body.' };
        }

        var stockRequestId = body.stockRequestId;
        if (!stockRequestId) {
            return { success: false, message: 'stockRequestId is required.' };
        }

        var action = body.action || SR.ACTION.APPROVE; // default preserves pre-reject callers
        if (action !== SR.ACTION.APPROVE && action !== SR.ACTION.REJECT) {
            return { success: false, message: 'Invalid action. Must be "approve" or "reject".' };
        }

        // --- Load Stock Transfer Request FIRST (authorization depends on ---
        // --- this record's Fulfilling Location) ---
        var stockRequest;
        try {
            stockRequest = record.load({
                type: SR.RECORD.STOCK_REQUEST,
                id: stockRequestId,
                isDynamic: false
            });
        } catch (e) {
            return { success: false, message: 'Stock Transfer Request could not be loaded: ' + e.message };
        }

        var requestingLocation = stockRequest.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST.REQUESTING_LOCATION
        });
        var fulfillingLocation = stockRequest.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION
        });

        // --- Independent, server-side authorization re-check (Test Case 15) ---
        // Same rule applies to approve and reject.
        if (!isCurrentUserAuthorized(fulfillingLocation)) {
            log.audit({
                title: 'SR_SL_ProcessApproval - unauthorized attempt',
                details: 'User ' + runtime.getCurrentUser().id + ' attempted to ' + action +
                    ' Stock Transfer Request ' + stockRequestId
            });
            return { success: false, message: 'You are not authorized to act on Stock Transfer Requests for this location.' };
        }

        // --- Re-validate status (Test Case 14) - applies to both actions ---
        var currentStatus = parseInt(
            stockRequest.getValue({ fieldId: SR.FIELD.STOCK_REQUEST.STATUS }), 10
        );
        if (currentStatus !== SR.STATUS.PENDING_APPROVAL) {
            var pastTense = (action === SR.ACTION.REJECT) ? 'rejected' : 'approved';
            return {
                success: false,
                message: 'This Stock Transfer Request is no longer Pending and cannot be ' + pastTense + ' again.'
            };
        }

        if (action === SR.ACTION.REJECT) {
            return rejectRequest(stockRequestId);
        }

        return approveRequest(stockRequest, stockRequestId, requestingLocation, fulfillingLocation);
    }

    /**
     * @param {ServerRequestContext} context
     */
    function onRequest(context) {
        if (context.request.method !== 'POST') {
            context.response.write(JSON.stringify({
                success: false,
                message: 'Method not allowed. This endpoint only accepts POST requests.'
            }));
            return;
        }

        var result;
        try {
            result = processApproval(context.request);
        } catch (e) {
            // No silent failures (TRD Error Handling Strategy - Suitelet layer).
            log.error({ title: 'SR_SL_ProcessApproval - unhandled error', details: e });
            result = {
                success: false,
                message: 'An unexpected server error occurred. Please contact your administrator.'
            };
        }

        context.response.write(JSON.stringify(result));
    }

    return {
        onRequest: onRequest
    };
});