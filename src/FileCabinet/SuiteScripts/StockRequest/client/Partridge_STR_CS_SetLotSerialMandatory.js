/**
 * @NApiVersion 2.0
 * @NScriptType ClientScript
 *
 * Makes the Lot Numbers/Serial Number field mandatory only for lot- or
 * serial-numbered items on Stock Request lines.
 */
define([
    'N/search',
    '../lib/Partridge_STR_Constants'
], function (search, SR) {

    function isChecked(value) {
        return value === true || value === 'T';
    }

    function setLotSerialMandatory(currentRecord) {
        var lotSerialField = currentRecord.getField({
            fieldId: SR.FIELD.STOCK_REQUEST_LINES.LOT_SERIAL_NUMBER
        });
        var itemId = currentRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST_LINES.ITEM
        });

        // Keep the field required until an item is selected and its type is known.
        lotSerialField.isMandatory = true;
        if (!itemId) {
            return;
        }

        try {
            var item = search.lookupFields({
                type: 'item',
                id: itemId,
                columns: ['isserialitem']
            });
            lotSerialField.isMandatory = isChecked(item.isserialitem);
        } catch (e) {
            alert('Unable to determine whether the selected item requires a Lot/Serial Number. ' +
                'The field will remain mandatory. Please try again, or contact your administrator.');
        }
    }

    function pageInit(context) {
        setLotSerialMandatory(context.currentRecord);
    }

    function fieldChanged(context) {
        if (context.fieldId === SR.FIELD.STOCK_REQUEST_LINES.ITEM) {
            setLotSerialMandatory(context.currentRecord);
        }
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged
    };
});
