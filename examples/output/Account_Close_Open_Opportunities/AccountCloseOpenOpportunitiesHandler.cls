/**
 * @description     Auto-generated Apex handler converted from Salesforce Flow.
 * @flowLabel       Account Close Open Opportunities
 * @triggerObject   Account
 * @apiVersion      59
 * @recordOperation Update
 * @triggerTiming   after save
 *  NOTE: This is a POC-generated skeleton. Review business logic,
 *  add CRUD/FLS checks, and write Apex tests before deploying.
 */
public with sharing class AccountCloseOpenOpportunitiesHandler {

    public static void afterSave(List<Account> records, Map<Id, Account> oldMap) {
        for (Account record : records) {
            // Entry filter from Flow start node
            if (!(record.Status__c == 'Inactive')) { continue; }
            // Get Records: Get Open Opportunities
            List<Opportunity> getOpenOpportunities = [SELECT Id FROM Opportunity WHERE AccountId = :record.Id AND IsClosed = false];
            // Loop: Loop Opportunities
            // Bulkification: DML inside loop detected (Update_Opportunity). DML lifted out of loop into Map<Id, Opportunity>.
            Map<Id, Opportunity> loopOpportunitiesToUpdate = new Map<Id, Opportunity>();
            for (Opportunity opportunitiesItem : getOpenOpportunities) {
                // Assignment: Set Stage to Closed Lost
                opportunitiesItem.StageName = 'Closed Lost';
                // Update Records: Update Opportunity
                loopOpportunitiesToUpdate.put(opportunitiesItem.Id, opportunitiesItem);
            }
            if (!loopOpportunitiesToUpdate.isEmpty()) {
                update loopOpportunitiesToUpdate.values();
            }
            // Assignment: End Loop
            record.Description = 'All open opportunities closed.';
        }
    }
}
