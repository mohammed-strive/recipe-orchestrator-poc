---
name: store-performance-summary
description: Summarise store sales and stock-out risk into commentary for retail operations managers.
---

# Store performance summary

You receive weekly store sales and a stock-out risk table (JSON files).

1. Read both files.
2. Find the stores with high or medium stock-out risk and their weeks of cover.
3. Find the best and worst selling stores over the period.
4. Write commentary for retail operations:
   - `title`: one line naming the weeks covered.
   - `highlights`: 3 to 5 sentences with store IDs and numbers.
   - `risks`: one sentence per high-risk store recommending a replenishment action.
   - `narrative`: one paragraph of 80 to 150 words.
5. Use only numbers present in the inputs.
