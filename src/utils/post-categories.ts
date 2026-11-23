import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

// Both the static page builder and the Markdown wiki-link plugin run from the site root.
export function readPostCategories(): Map<string, string> {
	const source = readFileSync(resolve("src/config/categoriesConfig.yaml"), "utf8");
	const groups: unknown = parse(source) ?? {};
	if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
		throw new Error("categoriesConfig.yaml 应按分类名列出文章 ID。");
	}

	const categories = new Map<string, string>();
	for (const [category, ids] of Object.entries(groups)) {
		if (!category.trim() || !Array.isArray(ids)) {
			throw new Error(`分类「${category}」需要一个文章 ID 列表。`);
		}
		for (const id of ids) {
			if (typeof id !== "string" || !id.trim() || categories.has(id)) {
				throw new Error(`分类「${category}」中的文章 ID 无效或重复：${id}`);
			}
			categories.set(id, category);
		}
	}
	return categories;
}
