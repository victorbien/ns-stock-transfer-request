/**
 * @NApiVersion 2.0
 * @NScriptType ClientScript
 *
 * Sets the Stock Transfer Request locations to the first active location
 * belonging to the selected From or To Subsidiary.
 */
define([
    'N/search',
    '../lib/Partridge_STR_Constants'
], function (search, SR) {

    function setLocationForSubsidiary(currentRecord, subsidiaryFieldId, locationFieldId) {
        var subsidiaryId = currentRecord.getValue({ fieldId: subsidiaryFieldId });

        currentRecord.setValue({
            fieldId: locationFieldId,
            value: ''
        });

        if (!subsidiaryId) {
            return;
        }

        var locations = search.create({
            type: SR.LOCATION.ID,
            filters: [
                [SR.LOCATION.FIELDS.SUBSIDIARY, search.Operator.ANYOF, subsidiaryId],
                'AND',
                [SR.LOCATION.FIELDS.INACTIVE, search.Operator.IS, 'F']
            ],
            columns: [SR.LOCATION.FIELDS.INTERNALID]
        }).run().getRange({ start: 0, end: 1 });

        if (locations.length > 0) {
            var locationId = locations[0].getValue({
                name: SR.LOCATION.FIELDS.INTERNALID
            });
            currentRecord.setValue({
                fieldId: locationFieldId,
                value: locationId
            });
        }
    }

    function fieldChanged(context) {
        var currentRecord = context.currentRecord;

        if (context.fieldId === SR.FIELD.STOCK_REQUEST.FROM_SUBSIDIARY) {
            setLocationForSubsidiary(
                currentRecord,
                SR.FIELD.STOCK_REQUEST.FROM_SUBSIDIARY,
                SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION
            );
        } else if (context.fieldId === SR.FIELD.STOCK_REQUEST.TO_SUBSIDIARY) {
            setLocationForSubsidiary(
                currentRecord,
                SR.FIELD.STOCK_REQUEST.TO_SUBSIDIARY,
                SR.FIELD.STOCK_REQUEST.REQUESTING_LOCATION
            );
        }
    }

    return {
        fieldChanged: fieldChanged
    };
});
