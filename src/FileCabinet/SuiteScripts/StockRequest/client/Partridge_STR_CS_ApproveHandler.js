/**
 * @NApiVersion 2.0
 * @NScriptType ClientScript
 *
 * SR_CS_ApproveHandler.js
 *
 * Implements FR-02 (Approval/Rejection Confirmation) and the client side
 * of FR-03 (Server-Side Approval Processing) from
 * "TRD - Stock Transfer Request Approval & Transfer Order Automation" v1.0.0.
 *
 * Loaded via form.clientScriptModulePath by SR_UE_AddApproveButton.js.
 * No standalone Script/Deployment record is required for this file, but
 * the file itself must exist in the File Cabinet at deployment time.
 *
 * *** SCOPE CHANGE (Reject action) ***
 * rejectStockRequest is bound to the new Reject button. Both actions
 * share submitAction(), which POSTs { stockRequestId, action } to the
 * same Suitelet endpoint and surfaces the result.
 *
 * PREREQUISITE (TRD FR-03 dependency, Constraints):
 * SR_SL_ProcessApproval must be created and deployed FIRST so its Script
 * ID / Deployment ID can be captured and hard-coded into
 * Partridge_STR_Constants.js (SUITELET.SCRIPT_ID / SUITELET.DEPLOYMENT_ID)
 * before this file is considered final.
 */
define([
    'N/https',
    'N/url',
    'N/ui/dialog',
    '../lib/Partridge_STR_Constants'
], function (https, url, dialog, SR) {

    /**
     * POSTs { stockRequestId, action } to SR_SL_ProcessApproval and
     * surfaces the structured JSON result to the user. Shared by both
     * Approve and Reject.
     * @param {number} stockRequestId
     * @param {string} action - SR.ACTION.APPROVE or SR.ACTION.REJECT
     * @param {string} successTitle
     */
    function submitAction(stockRequestId, action, successTitle) {
        try {
            var suiteletUrl = url.resolveScript({
                scriptId: SR.SUITELET.SCRIPT_ID,
                deploymentId: SR.SUITELET.DEPLOYMENT_ID,
                returnExternalUrl: false
            });

            var response = https.post({
                url: suiteletUrl,
                body: JSON.stringify({ stockRequestId: stockRequestId, action: action }),
                headers: { 'Content-Type': 'application/json' }
            });

            var result;
            try {
                result = JSON.parse(response.body);
            } catch (parseError) {
                dialog.alert({
                    title: 'Action Failed',
                    message: 'The server returned an unexpected response. Please contact your administrator.'
                });
                return;
            }

            if (result.success) {
                dialog.alert({
                    title: successTitle,
                    message: (result.message || '') +
                        (result.transferOrderId ? ' Transfer Order #' + result.transferOrderId + ' was created.' : '')
                }).then(function () {
                    window.location.reload();
                });
            } else {
                dialog.alert({
                    title: 'Action Failed',
                    message: result.message || 'The request could not be processed.'
                });
            }
        } catch (e) {
            // No silent failures (TRD Error Handling Strategy - Client Script layer).
            dialog.alert({
                title: 'Action Failed',
                message: 'An unexpected error occurred while contacting the server: ' + e.message
            });
        }
    }

    /**
     * Bound to the Approve button's functionName as
     * approveStockRequest(<recordId>).
     * @param {number} stockRequestId
     */
    function approveStockRequest(stockRequestId) {
        if (!stockRequestId) {
            dialog.alert({
                title: 'Unable to Approve',
                message: 'This Stock Transfer Request must be saved before it can be approved.'
            });
            return;
        }

        dialog.confirm({
            title: 'Confirm Approval',
            message: 'Approving this Stock Transfer Request will change its status to ' +
                'Approved and automatically create a Transfer Order from the ' +
                'Fulfilling Location to the Requesting Location. This action ' +
                'cannot be undone from this dialog. Continue?'
        }).then(function (confirmed) {
            if (confirmed) {
                submitAction(stockRequestId, SR.ACTION.APPROVE, 'Stock Transfer Request Approved');
            }
            // User cancelled: no side effects (FR-02).
        }).catch(function (reason) {
            // Dialog itself failed to render/resolve - treat as cancel, no side effects.
        });
    }

    /**
     * Bound to the Reject button's functionName as
     * rejectStockRequest(<recordId>).
     * @param {number} stockRequestId
     */
    function rejectStockRequest(stockRequestId) {
        if (!stockRequestId) {
            dialog.alert({
                title: 'Unable to Reject',
                message: 'This Stock Transfer Request must be saved before it can be rejected.'
            });
            return;
        }

        dialog.confirm({
            title: 'Confirm Rejection',
            message: 'Rejecting this Stock Transfer Request will change its status to ' +
                'Rejected. No Transfer Order will be created. This action cannot be ' +
                'undone from this dialog. Continue?'
        }).then(function (confirmed) {
            if (confirmed) {
                submitAction(stockRequestId, SR.ACTION.REJECT, 'Stock Transfer Request Rejected');
            }
            // User cancelled: no side effects (FR-02).
        }).catch(function (reason) {
            // Dialog itself failed to render/resolve - treat as cancel, no side effects.
        });
    }

    return {
        approveStockRequest: approveStockRequest,
        rejectStockRequest: rejectStockRequest
    };
});