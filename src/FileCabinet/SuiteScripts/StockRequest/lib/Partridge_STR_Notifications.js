/**
 * @NApiVersion 2.0
 * @NModuleScope SameAccount
 *
 * Sends Stock Transfer Request creation and decision notifications.
 */
define([
    'N/email',
    'N/runtime',
    'N/search',
    'N/url',
    './Partridge_STR_Constants'
], function (email, runtime, search, url, SR) {

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeUrlForHtmlAttribute(rawUrl) {
        return String(rawUrl).replace(/&/g, '&amp;');
    }

    function getEmployeeId(value) {
        if (Array.isArray(value)) {
            return value.length > 0 ? getEmployeeId(value[0]) : null;
        }
        if (value && typeof value === 'object' && value.value) {
            return String(value.value);
        }
        return value ? String(value) : null;
    }

    function getEmployeeName(employeeId) {
        if (!employeeId) {
            throw new Error('An employee ID is required to resolve the decision-maker name.');
        }

        var employee = search.lookupFields({
            type: search.Type.EMPLOYEE,
            id: employeeId,
            columns: ['entityid']
        });
        if (!employee.entityid) {
            throw new Error('Employee ' + employeeId + ' has no name available for the notification.');
        }

        return employee.entityid;
    }

    function getRequestRecipients(stockRequestId, additionalRecipientId) {
        var resultSet = search.create({
            type: SR.RECORD.STOCK_REQUEST,
            filters: [['internalid', 'anyof', stockRequestId]],
            columns: ['owner', 'lastmodifiedby']
        }).run().getRange({ start: 0, end: 1 });

        if (!resultSet.length) {
            throw new Error('Stock Transfer Request ' + stockRequestId + ' could not be found for notification.');
        }

        var recipients = [];
        var ownerId = getEmployeeId(resultSet[0].getValue({ name: 'owner' }));
        var lastModifiedById = getEmployeeId(resultSet[0].getValue({ name: 'lastmodifiedby' }));
        var candidateIds = [ownerId, lastModifiedById, getEmployeeId(additionalRecipientId)];

        for (var i = 0; i < candidateIds.length; i++) {
            if (candidateIds[i] && recipients.indexOf(candidateIds[i]) === -1) {
                recipients.push(candidateIds[i]);
            }
        }

        if (!recipients.length) {
            throw new Error('No Record Owner, Last Modified By, or actor recipient was available for Stock Transfer Request ' +
                stockRequestId + '.');
        }

        return recipients;
    }

    function sendStockRequestNotification(stockRequestId, eventType, actorId, recipientIds) {
        var recipients = recipientIds || getRequestRecipients(stockRequestId, actorId);
        var subject;
        var eventDescription;

        if (eventType === 'created') {
            subject = 'Stock Transfer Request #' + stockRequestId + ' Created';
            eventDescription = 'has been created.';
        } else {
            var action = eventType === 'approved' ? 'approved' : 'rejected';
            var actorName = getEmployeeName(actorId);
            subject = 'Stock Transfer Request #' + stockRequestId + ' ' +
                action.charAt(0).toUpperCase() + action.slice(1);
            eventDescription = 'was ' + action + ' by ' + escapeHtml(actorName) + '.';
        }

        var recordUrl = url.resolveRecord({
            recordType: SR.RECORD.STOCK_REQUEST,
            recordId: stockRequestId,
            isEditMode: false,
            returnExternalUrl: true
        });
        var body = '<p>Stock Transfer Request ' + eventDescription + '</p>' +
            '<table style="border-collapse:collapse;">' +
            '<tr>' +
            '<th style="padding:4px 8px;border:1px solid #ccc;text-align:left;">Stock Transfer Request</th>' +
            '<td style="padding:4px 8px;border:1px solid #ccc;">' +
            '<a href="' + escapeUrlForHtmlAttribute(recordUrl) + '">' +
            escapeHtml(stockRequestId) + '</a>' +
            '</td>' +
            '</tr>' +
            '</table>';

        var currentUserId = runtime.getCurrentUser().id;
        email.send({
            author: currentUserId > 0 ? currentUserId : -5,
            recipients: recipients,
            subject: subject,
            body: body
        });
    }

    return {
        getRequestRecipients: getRequestRecipients,
        sendStockRequestNotification: sendStockRequestNotification
    };
});
