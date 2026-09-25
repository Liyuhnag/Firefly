import type { CollectionEntry } from "astro:content";

export const sortPlans = (
	entries: CollectionEntry<"plan">[],
): CollectionEntry<"plan">[] =>
	entries.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

const taskItemPattern = /^\s*[-*+]\s+\[([ xX])\]/gm;

export const parsePlanProgress = (
	body: string | undefined,
): { done: number; total: number } => {
	const matches = (body || "").matchAll(taskItemPattern);
	let done = 0;
	let total = 0;
	for (const match of matches) {
		total++;
		if (match[1].toLowerCase() === "x") done++;
	}
	return { done, total };
};

export const formatPlanDate = (date: Date): string => {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
};
