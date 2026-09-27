/**
 * @NApiVersion 2.0
 * @NModuleScope SameAccount
 *
 * SR_Constants.js
 *
 * Central constants module for the Stock Transfer Request Approval & Transfer Order
 * Automation solution (TRD - Stock Transfer Request Approval & Transfer Order
 * Automation, v1.0.0).
 *
 * *** SCOPE CHANGE (location-based approval) ***
 * Approval eligibility is location-based: any active Employee whose
 * standard 'location' field equals the Stock Transfer Request's
 * Fulfilling Location is eligible to approve/reject. custentity_sr_is_approver
 * is not used anywhere in this solution.
 *
 * *** SCOPE CHANGE (Reject action) ***
 * A Reject action now exists alongside Approve. Rejecting a Stock
 * Transfer Request sets its status to Rejected and does NOT create a
 * Transfer Order. Both actions share the same Suitelet endpoint,
 * distinguished by the "action" value in the POST body (see ACTION
 * below), and the same authorization rule.
 *
 * *** SCOPE CHANGE (Intercompany Transfer Order) ***
 * Approval now creates an Intercompany Transfer Order
 * (record.Type.INTER_COMPANY_TRANSFER_ORDER), not a plain Transfer
 * Order. This requires FROM_SUBSIDIARY / TO_SUBSIDIARY on the header
 * (already present as custom fields on customrecord_stock_request) and
 * reads LOT_SERIAL_NUMBER (List/Record -> Inventory Number) per line to
 * populate the Inventory Detail subrecord via 'issueinventorynumber'.
 *
 * *** BUILD-SEQUENCE NOTE (see TRD Constraints / Assumptions) ***
 * customrecord_stock_request, customrecord_stock_request_lines, and the
 * status values do not exist yet. The STATUS internal IDs are almost
 * always auto-assigned integers and CANNOT be hard-coded correctly until
 * the list is built - do not deploy any script referencing them until the
 * real values are substituted here.
 */
define([], function () {

    var RECORD = {
        STOCK_REQUEST: 'customrecord_stock_request',
        STOCK_REQUEST_LINES: 'customrecord_stock_request_lines'
    };

    var FIELD = {
        STOCK_REQUEST: {
            REQUESTING_LOCATION: 'custrecord_sr_requesting_location',
            FULFILLING_LOCATION: 'custrecord_sr_fulfilling_location',
            STATUS: 'custrecord_sr_status',
            TRANSFER_ORDER: 'custrecord_sr_transfer_order', // now holds the Intercompany Transfer Order id
            FROM_SUBSIDIARY: 'custrecord_str_from_subsidiary', // source subsidiary - maps to Fulfilling Location
            TO_SUBSIDIARY: 'custrecord_str_to_subsidiary',      // destination subsidiary - maps to Requesting Location
            NOTES: 'custrecord_sr_notes',
            APPROVED_BY: 'custrecord_str_approved_by',
            DATE_APPROVED: 'custrecord_str_date_approved',
        },
        STOCK_REQUEST_LINES: {
            PARENT_STOCK_REQUEST: 'custrecord_srl_stock_request',
            ITEM: 'custrecord_srl_item',
            QUANTITY: 'custrecord_srl_quantity',

            FROM_SUBSIDIARY: 'custrecord_srl_from_subsidiary', // source subsidiary - maps to Fulfilling Location
            TO_SUBSIDIARY: 'custrecord_srl_to_subsidiary', // destination subsidiary - maps to Requesting Location
            FROM_LOCATION: 'custrecord_srl_parent_fulfilling_loc', // source location - maps to Fulfilling Location
            TO_LOCATION: 'custrecord_srl_parent_requesting_loc', // destination location - maps to Requesting Location

            // List/Record -> Inventory Number. Optional per line: only
            // lines with a value get an Inventory Detail assignment on
            // the Intercompany Transfer Order.
            LOT_SERIAL_NUMBER: 'custrecord_srl_lot_serial_number'
        },
        EMPLOYEE: {
            // Standard NetSuite Employee field - NOT a custom field.
            LOCATION: 'location',
            EMAIL: 'email',
            ACCESS: 'giveaccess'
        }
    };

    var STATUS = {
        PENDING_APPROVAL: 1,
        APPROVED: 2,
        TRANSFERRED: 3,
        REJECTED: 4
    };

    var ROLE = {
        ADMINISTRATOR: 3 // Native NetSuite Administrator role internal ID
    };

    var SUITELET = {
        SCRIPT_ID: 'customscript_str_sl_process_approval',
        DEPLOYMENT_ID: 'customdeploy_str_sl_process_approval'
    };

    var UE_SCRIPT = {
        CLIENT_SCRIPT_FILE_NAME: '../client/Partridge_STR_CS_ApproveHandler.js'
    };

    // Values sent in the Suitelet POST body's "action" property, and
    // used internally to branch approve vs. reject handling.
    var ACTION = {
        APPROVE: 'approve',
        REJECT: 'reject'
    };

    var MISC = {
        APPROVE_BUTTON_ID: 'custpage_sr_approve_btn',
        APPROVE_BUTTON_LABEL: 'Approve',
        APPROVE_FUNCTION_NAME: 'approveStockRequest',

        REJECT_BUTTON_ID: 'custpage_sr_reject_btn',
        REJECT_BUTTON_LABEL: 'Reject',
        REJECT_FUNCTION_NAME: 'rejectStockRequest'
    };

    return {
        RECORD: RECORD,
        FIELD: FIELD,
        STATUS: STATUS,
        ROLE: ROLE,
        SUITELET: SUITELET,
        UE_SCRIPT: UE_SCRIPT,
        ACTION: ACTION,
        MISC: MISC
    };
});