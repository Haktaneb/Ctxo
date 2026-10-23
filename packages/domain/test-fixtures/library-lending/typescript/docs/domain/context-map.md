# Context map

| Context | Rung | Role |
| --- | --- | --- |
| lending | pinned | Loans, returns and the loan limit per member |
| billing | bounded | Fines and invoices |
| catalog | fear | Books and their availability |

Lending asks Billing to charge fines through the charge service only.
