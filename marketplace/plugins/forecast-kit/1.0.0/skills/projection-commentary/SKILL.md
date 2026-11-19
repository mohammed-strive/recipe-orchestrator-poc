---
name: projection-commentary
description: Write analyst commentary on a revenue projection and its variance against the latest actuals.
---

# Projection commentary

You receive a revenue projection table and a variance table (JSON files).

1. Read both files.
2. Identify the regions with the largest positive and negative variance, and any region projected with the `naive` method (that means the linear model did not have enough history).
3. Write commentary for a finance audience:
   - `title`: one line naming the period covered.
   - `highlights`: 3 to 5 bullet sentences, each quoting the relevant numbers (USD, rounded to thousands) and region names.
   - `risks`: 1 to 3 sentences on what could make the projection wrong. Mention any naive-method regions here.
   - `narrative`: one paragraph of 80 to 150 words.
4. Use only numbers present in the input files. Do not invent figures.
