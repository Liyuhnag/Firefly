/* Create today's plan markdown file with front-matter. */

import fs from "node:fs";
import path from "node:path";
import { siteConfig } from "../src/config/siteConfig.ts";

const timezone = siteConfig.timezone || "Asia/Shanghai";
const now = new Date();
const dateParts = new Intl.DateTimeFormat("en-CA", {
	timeZone: timezone,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
})
	.formatToParts(now)
	.reduce((parts, part) => {
		if (part.type !== "literal") parts[part.type] = part.value;
		return parts;
	}, {});

const dateStr = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
const fileName = `${dateStr}.md`;
const targetDir = path.resolve("src/content/plan");
const fullPath = path.join(targetDir, fileName);

fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(fullPath)) {
	console.error(`Error: File ${fullPath} already exists`);
	process.exit(1);
}

const content = `---
date: ${dateStr}
title: ""
---

- [ ] 
`;

fs.writeFileSync(fullPath, content);

console.log(`Plan ${fullPath} created`);
