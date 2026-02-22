import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Resume, SkillCategory } from "../src/data/types.js";

export const RESUME_PATH = resolve(import.meta.dirname, "../src/data/resume.json");
export const IMAGES_DIR = resolve(import.meta.dirname, "../public/images");

export function loadExistingResume(): Partial<Resume> {
  if (existsSync(RESUME_PATH)) {
    try {
      const data = JSON.parse(readFileSync(RESUME_PATH, "utf-8"));
      console.log("Existing resume.json found, will merge data.");
      return data;
    } catch {
      console.log("Could not parse existing resume.json, creating new one.");
    }
  }
  return {};
}

export function writeResume(resume: Resume): void {
  writeFileSync(RESUME_PATH, JSON.stringify(resume, null, 2) + "\n", "utf-8");
  console.log(`\nResume written to: ${RESUME_PATH}`);
  console.log("Review the file and fill in any missing details (highlights, technologies, etc.).");
}

export async function downloadImage(url: string, filename: string): Promise<string | null> {
  try {
    mkdirSync(IMAGES_DIR, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const outputPath = resolve(IMAGES_DIR, filename);
    writeFileSync(outputPath, buffer);
    console.log(`  Image saved: ${outputPath}`);
    return `/images/${filename}`;
  } catch {
    console.log(`  Failed to download image: ${url}`);
    return null;
  }
}

export function formatLinkedInDate(dateStr?: string): string {
  if (!dateStr) return "";
  const parts = dateStr.trim().split(/[\s/-]+/);
  if (parts.length >= 2) {
    const monthMap: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const month = monthMap[parts[0].toLowerCase().slice(0, 3)];
    if (month) return `${parts[parts.length - 1]}-${month}`;
    if (/^\d{4}$/.test(parts[0])) return parts[0];
  }
  if (/^\d{4}$/.test(dateStr.trim())) return dateStr.trim();
  return dateStr.trim();
}

/**
 * Converts a Voyager API date object `{ month, year }` to "YYYY-MM" format.
 */
export function formatVoyagerDate(date?: { month?: number; year?: number }): string {
  if (!date?.year) return "";
  if (date.month) return `${date.year}-${String(date.month).padStart(2, "0")}`;
  return String(date.year);
}

export function categorizeSkills(skills: string[]): SkillCategory[] {
  if (skills.length === 0) return [];
  if (skills.length <= 8) {
    return [{ category: "Compétences", items: skills }];
  }

  const categories: Record<string, string[]> = {
    "Langages": [],
    "Frameworks & Librairies": [],
    "Outils & Plateformes": [],
    "Autres": [],
  };

  const langKeywords = ["javascript", "typescript", "python", "java", "c++", "c#", "go", "rust", "ruby", "php", "swift", "kotlin", "scala", "r", "sql", "html", "css", "bash", "shell", "perl", "lua", "dart", "objective-c"];
  const frameworkKeywords = ["react", "angular", "vue", "svelte", "next", "nuxt", "express", "django", "flask", "spring", "rails", "laravel", "fastapi", "nest", "tailwind", "bootstrap", ".net", "node", "deno", "astro", "gatsby", "remix", "graphql"];
  const toolKeywords = ["git", "docker", "kubernetes", "aws", "azure", "gcp", "jenkins", "terraform", "ansible", "jira", "figma", "linux", "nginx", "apache", "redis", "mongodb", "postgresql", "mysql", "elasticsearch", "kafka", "rabbitmq", "ci/cd", "github", "gitlab", "bitbucket", "cloudflare", "vercel", "heroku"];

  for (const skill of skills) {
    const lower = skill.toLowerCase();
    if (langKeywords.some((k) => lower.includes(k))) {
      categories["Langages"].push(skill);
    } else if (frameworkKeywords.some((k) => lower.includes(k))) {
      categories["Frameworks & Librairies"].push(skill);
    } else if (toolKeywords.some((k) => lower.includes(k))) {
      categories["Outils & Plateformes"].push(skill);
    } else {
      categories["Autres"].push(skill);
    }
  }

  return Object.entries(categories)
    .filter(([, items]) => items.length > 0)
    .map(([category, items]) => ({ category, items }));
}

export function mapProficiency(proficiency?: string): string {
  if (!proficiency) return "";
  const lower = proficiency.toLowerCase();
  if (lower.includes("native") || lower.includes("bilingual")) return "Langue maternelle / Bilingue";
  if (lower.includes("full professional") || lower.includes("full_professional")) return "Courant (C1/C2)";
  if (lower.includes("professional working") || lower.includes("professional_working")) return "Professionnel (B2)";
  if (lower.includes("limited working") || lower.includes("limited_working")) return "Intermédiaire (B1)";
  if (lower.includes("elementary")) return "Débutant (A2)";
  return proficiency;
}
