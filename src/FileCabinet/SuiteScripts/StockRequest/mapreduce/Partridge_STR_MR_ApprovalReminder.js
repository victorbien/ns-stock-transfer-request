/**
 * @NApiVersion 2.0
 * @NScriptType MapReduceScript
 *
 * SR_MR_ApprovalReminder.js
 *
 * Implements FR-04 (Daily Reminder Notification) from
 * "TRD - Stock Transfer Request Approval & Transfer Order Automation" v1.0.0.
 *
 * *** SCOPE CHANGE ***
 * Approval eligibility is location-based (see SR_UE_AddApproveButton.js /
 * SR_SL_ProcessApproval.js), so a single global digest sent to every
 * "approver" no longer makes sense - different Stock Transfer Requests
 * can have different eligible approvers depending on their own Fulfilling
 * Location. This script now GROUPS pending requests by Fulfilling
 * Location and sends each location's active Employees a digest of only
 * the requests they are eligible to approve.
 *
 * Schedule: Daily, deployment-level schedule configured at deployment
 * creation time (no existing schedule to inherit).
 *
 * getInputData : all active customrecord_stock_request where status =
 *                Pending Approval AND that have at least one related
 *                customrecord_stock_request_lines record (SQL EXISTS
 *                formula filter - see getInputData for why a formula is
 *                used instead of a join)
 * map          : emits each pending SR keyed by its OWN Fulfilling
 *                Location internal ID, so reduce() receives, per
 *                location, only the requests relevant to that location.
 *                Also resolves an absolute URL to the record itself
 *                (N/url, returnExternalUrl: true) so the digest email
 *                can link directly to it.
 * reduce       : for each Fulfilling Location key, looks up active
 *                Employees whose 'location' field equals that location
 *                and who have an Email Address set; if there are
 *                pending SRs AND eligible employees, sends one HTML
 *                summary email per employee (BR-11); sends nothing, but
 *                logs, if either list is empty (BR-12)
 * summarize    : logs every map/reduce stage error individually plus
 *                governance usage (TRD Error Handling Strategy)
 *
 * Prerequisite: customrecord_stock_request must exist with the Status
 * and Fulfilling Location fields populated with real data before this
 * can be meaningfully tested (TRD FR-04 dependency).
 */
define([
    'N/search',
    'N/email',
    'N/runtime',
    'N/url',
    'N/log',
    '../lib/Partridge_STR_Constants'
], function (search, email, runtime, url, log, SR) {
    var PARAM_SAVED_SEARCH_ID = 'custscript_str_saved_search_for_email';

    /**
     * Escapes ampersands so a NetSuite URL (which commonly contains
     * '&' between query parameters) is valid inside an HTML attribute.
     * @param {string} rawUrl
     * @returns {string}
     */
    function escapeUrlForHtmlAttribute(rawUrl) {
        return String(rawUrl).replace(/&/g, '&amp;');
    }

    /**
     * @returns {Search} saved search of active, Pending Approval Stock
     * Transfer Requests that have at least one Stock Transfer Request
     * Lines record. There is no automatic reverse join from
     * customrecord_stock_request to customrecord_stock_request_lines,
     * so this uses a SQL EXISTS formula filter against the lines table
     * instead of a join-based filter.
     */
    function getInputData() {
        var scriptObj = runtime.getCurrentScript();
        var savedSearchId = scriptObj.getParameter({ name: PARAM_SAVED_SEARCH_ID });

        if (!savedSearchId) {
            throw error.create({
                name: 'MISSING_SCRIPT_PARAMETER',
                message: 'Script parameter ' + PARAM_SAVED_SEARCH_ID + ' (saved search internal ID) is required but was not provided.'
            });
        }

        try {
            return search.load({ id: savedSearchId });
        } catch (e) {
            throw error.create({
                name: 'SAVED_SEARCH_LOAD_FAILED',
                message: 'Could not load saved search id ' + savedSearchId + ' - ' + (e && e.message ? e.message : e)
            });
        }
    }

    /**
     * Emits each pending Stock Transfer Request keyed by its own
     * Fulfilling Location internal ID (SCOPE CHANGE - previously all
     * requests shared one key regardless of location). reduce() then
     * runs once per distinct Fulfilling Location, receiving only the
     * requests relevant to that location's staff.
     * @param {MapContext} context
     */
    function map(context) {
        try {
            var result = JSON.parse(context.value);
            var values = result.values;

            log.debug({ title: 'SR_MR_ApprovalReminder - map', details: 'Processing Stock Transfer Request ' + result.id });
            
            var fulfillingLocationField = values[SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION];
            var fulfillingLocationId = fulfillingLocationField ? fulfillingLocationField.value : null;

            if (!fulfillingLocationId) {
                // Cannot notify anyone for a request with no Fulfilling
                // Location set - log it and skip rather than guessing.
                log.error({
                    title: 'SR_MR_ApprovalReminder - missing Fulfilling Location',
                    details: 'Stock Transfer Request ' + result.id + ' has no Fulfilling Location and was skipped.'
                });
                return;
            }

            // Absolute (fully-qualified) URL so the link resolves correctly
            // from an email client, not just from inside NetSuite.
            var recordUrl = url.resolveRecord({
                recordType: SR.RECORD.STOCK_REQUEST,
                recordId: result.id,
                isEditMode: false,
                returnExternalUrl: true
            });

            var stockRequestSummary = {
                id: result.id,
                recordUrl: recordUrl,
                requestingLocation: values[SR.FIELD.STOCK_REQUEST.REQUESTING_LOCATION].text ||
                    values[SR.FIELD.STOCK_REQUEST.REQUESTING_LOCATION].value,
                fulfillingLocation: fulfillingLocationField.text || fulfillingLocationField.value,
                created: values.created
            };

            context.write({
                key: fulfillingLocationId,
                value: JSON.stringify(stockRequestSummary)
            });
        } catch (e) {
            // Per-record isolation: one bad record must not fail the whole run.
            log.error({ title: 'SR_MR_ApprovalReminder - map error', details: e });
        }
    }

    /**
     * Active Employees whose standard 'location' field equals the given
     * Fulfilling Location, AND who have an Email Address set (an
     * employee with no email cannot receive the reminder, so excluding
     * them here avoids a guaranteed-failed email.send call per employee).
     * @param {string} fulfillingLocationId
     * @returns {Array<{id: string, name: string}>}
     */
    function getEligibleEmployeesForLocation(fulfillingLocationId) {
        var employees = [];
        var employeeSearch = search.create({
            type: search.Type.EMPLOYEE,
            filters: [
                [SR.FIELD.EMPLOYEE.LOCATION, 'anyof', fulfillingLocationId],
                'AND',
                ['isinactive', 'is', 'F'],
                'AND',
                [SR.FIELD.EMPLOYEE.EMAIL, 'isnotempty', ''],
                'AND',
                [SR.FIELD.EMPLOYEE.ACCESS, 'is', 'T']
            ],
            columns: ['internalid', 'entityid']
        });

        employeeSearch.run().each(function (resultRow) {
            employees.push({
                id: resultRow.getValue('internalid'),
                name: resultRow.getValue('entityid')
            });
            return true;
        });

        return employees;
    }

    /**
     * @param {Array<{id:string, recordUrl:string, requestingLocation:string, fulfillingLocation:string, created:string}>} pendingRequests
     * @returns {string} HTML table summarising all pending Stock Transfer Requests
     */
    function buildSummaryEmailBody(pendingRequests) {
        var rows = pendingRequests.map(function (sr) {
            return '<tr>' +
                '<td style="padding:4px 8px;border:1px solid #ccc;">' +
                '<a href="' + escapeUrlForHtmlAttribute(sr.recordUrl) + '">' + sr.id + '</a>' +
                '</td>' +
                '<td style="padding:4px 8px;border:1px solid #ccc;">' + sr.requestingLocation + '</td>' +
                '<td style="padding:4px 8px;border:1px solid #ccc;">' + sr.fulfillingLocation + '</td>' +
                '<td style="padding:4px 8px;border:1px solid #ccc;">' + sr.created + '</td>' +
                '</tr>';
        }).join('');

        return '<p>The following Stock Transfer Requests are pending your approval:</p>' +
            '<table style="border-collapse:collapse;">' +
            '<tr>' +
            '<th style="padding:4px 8px;border:1px solid #ccc;">SR #</th>' +
            '<th style="padding:4px 8px;border:1px solid #ccc;">Requesting Location</th>' +
            '<th style="padding:4px 8px;border:1px solid #ccc;">Fulfilling Location</th>' +
            '<th style="padding:4px 8px;border:1px solid #ccc;">Created Date</th>' +
            '</tr>' +
            rows +
            '</table>';
    }

    /**
     * Runs once per distinct Fulfilling Location. Builds one consolidated
     * HTML email and sends it to every active Employee at that location
     * (BR-11). Sends nothing if there are zero eligible employees at that
     * location, logging the case (BR-12).
     * @param {ReduceContext} context
     */
    function reduce(context) {
        try {
            var fulfillingLocationId = context.key;

            var pendingRequests = context.values.map(function (value) {
                return JSON.parse(value);
            });

            if (pendingRequests.length === 0) {
                return; // Not expected - reduce only runs for keys with values.
            }

            var eligibleEmployees = getEligibleEmployeesForLocation(fulfillingLocationId);
            if (eligibleEmployees.length === 0) {
                log.audit({
                    title: 'SR_MR_ApprovalReminder - no eligible employees at location',
                    details: pendingRequests.length + ' pending Stock Transfer Request(s) found for ' +
                        'Fulfilling Location ' + fulfillingLocationId + ', but no active Employee has ' +
                        'that location set. No reminder emails sent.'
                });
                return;
            }

            var htmlBody = buildSummaryEmailBody(pendingRequests);
            var senderId = runtime.getCurrentScript().getParameter({ name: 'custscript_sr_reminder_sender' }) 
                || -5; // Default to System if no sender specified

            for (var i = 0; i < eligibleEmployees.length; i++) {
                try {
                    email.send({
                        author: senderId,
                        recipients: eligibleEmployees[i].id,
                        subject: 'Stock Transfer Requests Pending Your Approval (' + pendingRequests.length + ')',
                        body: htmlBody
                    });
                } catch (sendError) {
                    // Isolate per-employee send failures - one bad email address
                    // should not stop the others from being sent.
                    log.error({
                        title: 'SR_MR_ApprovalReminder - email send failed',
                        details: 'Employee ' + eligibleEmployees[i].id + ': ' + sendError.message
                    });
                }
            }
        } catch (e) {
            log.error({ title: 'SR_MR_ApprovalReminder - reduce error', details: e });
        }
    }

    /**
     * @param {SummarizeContext} summary
     */
    function summarize(summary) {
        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error({ title: 'SR_MR_ApprovalReminder - map stage error', details: key + ': ' + error });
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error({ title: 'SR_MR_ApprovalReminder - reduce stage error', details: key + ': ' + error });
            return true;
        });

        log.audit({
            title: 'SR_MR_ApprovalReminder - summary',
            details: 'Usage consumed: ' + summary.usage + ' units, ' +
                summary.concurrency + ' concurrency, ' + summary.yields + ' yields.'
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});