## after apply and save

### git diff src/app.ts
diff --git a/src/app.ts b/src/app.ts
index <sha>..<sha> 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 export function add(a: number, b: number) {
-  // TODO validate input
+if (!Number.isFinite(a + b)) throw new Error("bad");
   return a + b + 0;
 }


### review files
### <id>.review
---
severity: high
status: open
file: src/app.ts
lines: 2
---
**human**:
Use a guard.
```suggestion
if (!Number.isFinite(a + b)) throw new Error("bad");
```
