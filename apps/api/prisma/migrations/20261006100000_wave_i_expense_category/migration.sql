-- Wave I groundwork (phase-3-financial.md §4): the expense_category enum, in its own migration
-- before the expenses table and its CHECKs use it (§4: ExpenseCategory gets its own migration, like
-- the MessageType values of 20261005180725_phase3_message_types).

-- CreateEnum
CREATE TYPE "expense_category" AS ENUM ('electricity', 'water', 'internet', 'cleaning', 'stationery', 'repairs', 'maintenance', 'fuel', 'transport', 'building', 'daily_purchases', 'salary_advance_cash', 'cash_shortfall', 'other');
