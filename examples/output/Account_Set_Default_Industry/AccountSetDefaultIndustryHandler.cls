/**
 * @description     Auto-generated Apex handler converted from Salesforce Flow.
 * @flowLabel       Account Set Default Industry
 * @triggerObject   Account
 * @apiVersion      59
 * @recordOperation Create
 * @triggerTiming   before save
 *  NOTE: This is a POC-generated skeleton. Review business logic,
 *  add CRUD/FLS checks, and write Apex tests before deploying.
 */
public with sharing class AccountSetDefaultIndustryHandler {

    public static void beforeSave(List<Account> records) {
        for (Account record : records) {
            // Decision: Check if Industry is empty
            if (record.Industry == null) {
                // Assignment: Set Industry to Other
                record.Industry = 'Other';
            }
        }
    }
}
