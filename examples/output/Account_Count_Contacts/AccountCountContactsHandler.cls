/**
 * @description     Auto-generated Apex handler converted from Salesforce Flow.
 * @flowLabel       Account Count Contacts
 * @triggerObject   Account
 * @apiVersion      59
 * @recordOperation CreateAndUpdate
 * @triggerTiming   after save
 *  NOTE: This is a POC-generated skeleton. Review business logic,
 *  add CRUD/FLS checks, and write Apex tests before deploying.
 */
public with sharing class AccountCountContactsHandler {

    public static void afterSave(List<Account> records, Map<Id, Account> oldMap) {
        Map<Id, Account> recordsToUpdate = new Map<Id, Account>();

        for (Account record : records) {
            // Get Records: Get Related Contacts
            List<Contact> getRelatedContacts = [SELECT Id FROM Contact WHERE AccountId = :record.Id];
            // Assignment: Set Contact Count
            record.NumberOfEmployees = getRelatedContacts.size();
            // Update Records: Update Account
            // $Record updates in before-save context are written by the platform automatically.
            // In after-save context the trigger framework re-fires; collect for batched DML instead.
            recordsToUpdate.put(record.Id, record);
        }
        if (!recordsToUpdate.isEmpty()) {
            update recordsToUpdate.values();
        }

    }
}
