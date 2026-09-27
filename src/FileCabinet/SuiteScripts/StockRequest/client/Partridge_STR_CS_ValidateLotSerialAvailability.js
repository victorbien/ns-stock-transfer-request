/**
 * @NApiVersion 2.0
 * @NScriptType ClientScript
 *
 * SR_CS_ValidateLotSerialAvailability.js
 *
 * Deployed on customrecord_stock_request_lines.
 *
 * Validates that the Lot Number/Serial Number selected in
 * custrecord_srl_lot_serial_number (List/Record -> Inventory Number) has
 * Available Quantity greater than zero, and that the requested line
 * Quantity does not exceed the Available Quantity for that lot/serial at
 * the Fulfilling Location.
 *
 * *** IMPORTANT - NOT YET VERIFIED AGAINST A LIVE ACCOUNT ***
 * This uses the 'inventorynumberbin' search type (internal ID passed as a
 * literal string, not via search.Type, to avoid guessing at the exact
 * enum key name) with columns 'inventorynumber', 'location', and
 * 'quantityavailable'. These are inferred from NetSuite's SOAP schema for
 * the "Inventory Number/Bin" search (confirmed field names: binNumber,
 * inventoryNumber, location, quantityAvailable, quantityOnHand) and from
 * general SuiteScript column-naming convention (lowercase, no
 * underscores) - NOT from a directly-confirmed working SuiteScript code
 * sample. Test this against a line with a KNOWN in-stock lot/serial
 * before relying on it. If results come back empty for a lot/serial you
 * know has stock, the most likely culprit is the column or type name
 * needing a small correction, not the overall approach.
 *
 * DESIGN NOTE - location-specific, not global:
 * Availability is checked at the Stock Transfer Request's Fulfilling
 * Location specifically (the location stock is being transferred FROM),
 * not a company-wide total. A lot/serial with plenty of stock elsewhere
 * but none at the Fulfilling Location will still be rejected, which is
 * the intended behavior for a transfer. If the parent Stock Transfer
 * Request's Fulfilling Location cannot be resolved (e.g. the line's
 * parent reference is blank), the check falls back to a company-wide
 * total rather than blocking the field outright - flag if you'd rather
 * it block in that edge case instead.
 */
define([
    'N/search',
    '../lib/Partridge_STR_Constants'
], function (search, SR) {

    /**
     * Looks up the Fulfilling Location internal ID of this line's parent
     * Stock Transfer Request. Returns null if the parent isn't set yet,
     * or if the lookup fails for any reason.
     * @param {CurrentRecord} currentRecord
     * @returns {string|null}
     */
    function getFulfillingLocationId(currentRecord) {
        var parentStockRequestId = currentRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST
        });
        if (!parentStockRequestId) {
            return null;
        }

        try {
            var result = search.lookupFields({
                type: SR.RECORD.STOCK_REQUEST,
                id: parentStockRequestId,
                columns: [SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION]
            });
            var locationField = result[SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION];
            if (Array.isArray(locationField) && locationField.length > 0) {
                return locationField[0].value;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Sums Available Quantity for the given Inventory Number, optionally
     * restricted to a specific Location. Summed across rows because an
     * item using Bin Management can have the same lot/serial split
     * across multiple bins within one location.
     * @param {string} inventoryNumberId
     * @param {string|null} locationId
     * @returns {number}
     */
    function getAvailableQuantity(inventoryNumberId, locationId) {
        if (!inventoryNumberId) return 0;

        // 1. Define filters targeting the specific Inventory Number
        var filters = [['internalid', 'anyof', inventoryNumberId]];
        
        // 2. Add Location filter if provided
        if (locationId) {
            filters.push('AND');
            filters.push(['location', 'anyof', locationId]);
        }

        // 3. Create search on 'inventorynumber' instead of 'inventorynumberbin'
        var inventorySearch = search.create({
            type: 'inventorynumber', 
            filters: filters,
            columns: [
                // NetSuite stores the aggregate available quantity at the location level here
                search.createColumn({ name: 'quantityavailable' })
            ]
        });

        var total = 0;
        var results = inventorySearch.run().getRange({ start: 0, end: 50 });
        
        for (var i = 0; i < results.length; i++) {
            total += parseFloat(results[i].getValue({ name: 'quantityavailable' })) || 0;
        }
        
        return total;
    }

    /**
     * @param {Object} context
     * @param {CurrentRecord} context.currentRecord
     * @param {string} context.fieldId
     * @returns {boolean} false rejects the entered value; NetSuite reverts the field
     */
    function validateField(context) {
        var currentRecord = context.currentRecord;

        if (context.fieldId === SR.FIELD.STOCK_REQUEST_LINES.QUANTITY) {
            var itemId = currentRecord.getValue({
                fieldId: SR.FIELD.STOCK_REQUEST_LINES.ITEM
            });
            var inventoryNumberId = currentRecord.getValue({
                fieldId: SR.FIELD.STOCK_REQUEST_LINES.LOT_SERIAL_NUMBER
            });

            if (!itemId || !inventoryNumberId) {
                return true;
            }

            var requestedQuantity = parseFloat(currentRecord.getValue({
                fieldId: SR.FIELD.STOCK_REQUEST_LINES.QUANTITY
            }));
            if (isNaN(requestedQuantity)) {
                return true;
            }

            var fulfillingLocationId = getFulfillingLocationId(currentRecord);
            var availableQuantity;

            try {
                availableQuantity = getAvailableQuantity(inventoryNumberId, fulfillingLocationId);
            } catch (e) {
                alert('Unable to verify Available Quantity for the selected Lot/Serial Number right now. ' +
                    'Please try again, or contact your administrator if this continues.');
                return false;
            }

            if (requestedQuantity > availableQuantity) {
                var locationNote = fulfillingLocationId ? ' at the Fulfilling Location' : '';
                alert('The requested Quantity exceeds the Available Quantity' + locationNote +
                    ' for the selected Lot/Serial Number. Please enter a lower Quantity.');
                return false;
            }

            return true;
        }

        if (context.fieldId !== SR.FIELD.STOCK_REQUEST_LINES.LOT_SERIAL_NUMBER) {
            return true;
        }

        var lotSerialNumberId = currentRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST_LINES.LOT_SERIAL_NUMBER
        });

        if (!lotSerialNumberId) {
            return true; // blank is allowed - lot/serial is optional per line
        }

        var fulfillingLocationId = getFulfillingLocationId(currentRecord);

        var availableQuantity;
        
        try {
            availableQuantity = getAvailableQuantity(lotSerialNumberId, fulfillingLocationId);
        } catch (e) {
            // Fail closed: if we can't verify availability, don't silently accept the selection.
            alert('Unable to verify Available Quantity for the selected Lot/Serial Number right now. ' +
                'Please try again, or contact your administrator if this continues.');
            return false;
        }
        
        if (availableQuantity <= 0) {
            var locationNote = fulfillingLocationId ? ' at the Fulfilling Location' : '';
            alert('The selected Lot/Serial Number has no Available Quantity' + locationNote +
                ' and cannot be used. Please choose a different one.');
            return false;
        }

        return true;
    }

    return {
        validateField: validateField
    };
});
