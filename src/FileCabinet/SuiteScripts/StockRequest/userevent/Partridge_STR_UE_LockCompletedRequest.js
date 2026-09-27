/**
 * @NApiVersion 2.0
 * @NScriptType UserEventScript
 *
 * Prevents editing or deleting an approved or rejected Stock Transfer
 * Request and its existing lines.
 */
define([
    'N/error',
    'N/log',
    'N/search',
    'N/ui/message',
    '../lib/Partridge_STR_Constants',
    '../lib/Partridge_STR_Notifications'
], function (error, log, search, message, SR, notifications) {

    function isLockedStatus(statusId) {
        var status = parseInt(statusId, 10);
        return status === SR.STATUS.APPROVED || status === SR.STATUS.REJECTED;
    }

    function getParentStatusId(parentStockRequestId) {
        if (!parentStockRequestId) {
            return null;
        }

        var result = search.lookupFields({
            type: SR.RECORD.STOCK_REQUEST,
            id: parentStockRequestId,
            columns: [SR.FIELD.STOCK_REQUEST.STATUS]
        });
        var statusField = result[SR.FIELD.STOCK_REQUEST.STATUS];
        if (Array.isArray(statusField)) {
            return statusField.length > 0 ? statusField[0].value : null;
        }
        return statusField || null;
    }

    function rejectMutation(message) {
        throw error.create({
            name: 'STR_COMPLETED_REQUEST_LOCKED',
            message: message,
            notifyOff: true
        });
    }

    function showLockedBanner(form, messageText) {
        form.addPageInitMessage({
            type: message.Type.WARNING,
            title: 'Stock Transfer Request Locked',
            message: messageText
        });
    }

    function validateStockRequestLocations(stockRequestRecord) {
        var requestingLocationId = stockRequestRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST.REQUESTING_LOCATION
        });
        var fulfillingLocationId = stockRequestRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST.FULFILLING_LOCATION
        });

        if (requestingLocationId && fulfillingLocationId &&
            String(requestingLocationId) === String(fulfillingLocationId)) {
            throw error.create({
                name: 'STR_LOCATIONS_MUST_DIFFER',
                message: 'Requesting Location (To Location) must be different from Fulfilling Location (From Location).',
                notifyOff: true
            });
        }
    }

    function beforeLoad(context) {
        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT &&
            context.type !== context.UserEventType.VIEW) {
            return;
        }

        var currentRecord = context.newRecord;

        if (currentRecord.type === SR.RECORD.STOCK_REQUEST) {
            if (isLockedStatus(currentRecord.getValue({
                fieldId: SR.FIELD.STOCK_REQUEST.STATUS
            }))) {
                showLockedBanner(
                    context.form,
                    'This Stock Transfer Request is approved or rejected and cannot be edited or deleted.'
                );
            }
            return;
        }

        if (currentRecord.type !== SR.RECORD.STOCK_REQUEST_LINES) {
            return;
        }

        var parentStockRequestId = currentRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST
        });
        if (!isLockedStatus(getParentStatusId(parentStockRequestId))) {
            return;
        }

        if (context.type === context.UserEventType.CREATE) {
            showLockedBanner(
                context.form,
                'A new line cannot be created for an approved or rejected Stock Transfer Request.'
            );
        } else {
            showLockedBanner(
                context.form,
                'This line belongs to an approved or rejected Stock Transfer Request and cannot be edited or deleted.'
            );
        }
    }

    function beforeSubmit(context) {
        if (context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT &&
            context.type !== context.UserEventType.DELETE) {
            return;
        }

        if (context.type === context.UserEventType.CREATE) {
            if (context.newRecord.type === SR.RECORD.STOCK_REQUEST) {
                validateStockRequestLocations(context.newRecord);
                return;
            }

            if (context.newRecord.type === SR.RECORD.STOCK_REQUEST_LINES) {
                var newLineParentId = context.newRecord.getValue({
                    fieldId: SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST
                });
                if (isLockedStatus(getParentStatusId(newLineParentId))) {
                    rejectMutation('A new line cannot be created for an approved or rejected Stock Transfer Request.');
                }
            }
            return;
        }

        var action = context.type === context.UserEventType.DELETE ? 'deleted' : 'edited';
        var oldRecord = context.oldRecord;

        if (oldRecord.type === SR.RECORD.STOCK_REQUEST) {
            if (isLockedStatus(oldRecord.getValue({
                fieldId: SR.FIELD.STOCK_REQUEST.STATUS
            }))) {
                rejectMutation('An approved or rejected Stock Transfer Request cannot be ' + action + '.');
            }
            validateStockRequestLocations(context.newRecord);
            return;
        }

        if (oldRecord.type !== SR.RECORD.STOCK_REQUEST_LINES) {
            return;
        }

        var oldParentId = oldRecord.getValue({
            fieldId: SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST
        });
        if (isLockedStatus(getParentStatusId(oldParentId))) {
            rejectMutation('A line belonging to an approved or rejected Stock Transfer Request cannot be ' +
                action + '.');
        }

        if (context.type === context.UserEventType.EDIT) {
            var newParentId = context.newRecord.getValue({
                fieldId: SR.FIELD.STOCK_REQUEST_LINES.PARENT_STOCK_REQUEST
            });
            if (newParentId && String(newParentId) !== String(oldParentId) &&
                isLockedStatus(getParentStatusId(newParentId))) {
                rejectMutation('A line cannot be moved to an approved or rejected Stock Transfer Request.');
            }
        }
    }

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE ||
            context.newRecord.type !== SR.RECORD.STOCK_REQUEST) {
            return;
        }

        try {
            notifications.sendStockRequestNotification(context.newRecord.id, 'created');
        } catch (e) {
            log.error({
                title: 'STR LockCompletedRequest - creation notification failed',
                details: 'Stock Transfer Request ' + context.newRecord.id + ': ' + e.message
            });
        }
    }

    return {
        beforeLoad: beforeLoad,
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
