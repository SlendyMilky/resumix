import { chromium, type BrowserContext, type Page } from "playwright";
import type { Resume, Experience, Education, Certification } from "../src/data/types.js";
import {
  IMAGES_DIR,
  loadExistingResume,
  writeResume,
  categorizeSkills,
  mapProficiency,
} from "./linkedin-shared.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;
const SCROLL_PAUSE_MS = 600;
const COOKIES_PATH = resolve(import.meta.dirname, "../.linkedin-cookies.json");

// ---------------------------------------------------------------------------
// Cookie persistence
// ---------------------------------------------------------------------------

async function saveCookies(context: BrowserContext): Promise<void> {
  const state = await context.storageState();
  writeFileSync(COOKIES_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function loadSavedCookies(): any | null {
  if (!existsSync(COOKIES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function scrollToBottom(page: Page): Promise<void> {
  let previousHeight = 0;
  let stableCount = 0;

  while (stableCount < 3) {
    const currentHeight = await page.evaluate("document.body.scrollHeight") as number;
    if (currentHeight === previousHeight) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    previousHeight = currentHeight;
    await page.evaluate("window.scrollBy(0, window.innerHeight * 0.8)");
    await page.waitForTimeout(SCROLL_PAUSE_MS);
  }
}

async function loadDetailPage(page: Page, publicId: string, section: string): Promise<void> {
  await page.goto(`https://www.linkedin.com/in/${publicId}/details/${section}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await scrollToBottom(page);
  await page.waitForTimeout(1000);
}

/**
 * Extracts innerText from each <li> on the current page,
 * split into lines for easier parsing.
 */
async function extractListItems(page: Page): Promise<string[][]> {
  return page.evaluate(`(() => {
    var lis = document.querySelectorAll("main li");
    var result = [];
    for (var i = 0; i < lis.length; i++) {
      var text = lis[i].innerText || "";
      var lines = text.split("\\n").map(function(l) { return l.trim(); }).filter(Boolean);
      if (lines.length >= 1) result.push(lines);
    }
    return result;
  })()`) as unknown as string[][];
}

async function saveProfilePhoto(page: Page): Promise<string | null> {
  const photoUrl = await page.evaluate(`(() => {
    var imgs = document.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].src || "";
      if (src.includes("profile-displayphoto") && !src.includes("ghost")) return src;
    }
    return null;
  })()`) as string | null;

  if (!photoUrl) return null;

  try {
    const res = await fetch(photoUrl as string);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    mkdirSync(IMAGES_DIR, { recursive: true });
    const outputPath = resolve(IMAGES_DIR, "profile.jpg");
    writeFileSync(outputPath, buffer);
    console.log(`  Profile photo saved.`);
    return "/images/profile.jpg";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Login (with cookie reuse)
// ---------------------------------------------------------------------------

async function launchAndLogin(): Promise<{ context: BrowserContext; page: Page }> {
  console.log("Launching browser…");

  const savedState = loadSavedCookies();
  const browser = await chromium.launch({ headless: false });
  const contextOptions: any = {
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
  if (savedState) contextOptions.storageState = savedState;

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  if (savedState) {
    console.log("  Checking saved session…");
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const isLoggedIn = await page.evaluate(`(() => {
      return !window.location.pathname.includes("/login") &&
             !window.location.pathname.includes("/authwall") &&
             !window.location.pathname.includes("/checkpoint");
    })()`) as boolean;

    if (isLoggedIn) {
      console.log("  Session valid — skipping login.\n");
      return { context, page };
    }
    console.log("  Session expired — need to log in again.");
  }

  await page.goto("https://www.linkedin.com/login");
  console.log("  Please log in to LinkedIn in the browser window.");
  console.log(`  You have ${LOGIN_TIMEOUT_MS / 1000}s to complete the login.\n`);

  try {
    await page.waitForURL((url) => {
      const path = url.pathname;
      return path === "/feed/" || path === "/feed" || path.startsWith("/in/") || path === "/";
    }, { timeout: LOGIN_TIMEOUT_MS });
  } catch {
    await browser.close();
    throw new Error("Login timeout — you did not complete the login in time.");
  }

  console.log("Login successful.\n");
  await saveCookies(context);
  return { context, page };
}

async function resolveOwnProfile(context: BrowserContext): Promise<{ profileUrl: string; publicId: string }> {
  const cookies = await context.cookies("https://www.linkedin.com");
  const liAt = cookies.find((c) => c.name === "li_at")?.value;
  const jsessionId = cookies.find((c) => c.name === "JSESSIONID")?.value?.replace(/"/g, "");

  if (!liAt || !jsessionId) throw new Error("Missing LinkedIn cookies after login.");

  const res = await fetch("https://www.linkedin.com/voyager/api/me", {
    headers: {
      "Cookie": `li_at=${liAt}; JSESSIONID="${jsessionId}"`,
      "Csrf-Token": jsessionId,
      "Accept": "application/vnd.linkedin.normalized+json+2.1",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) throw new Error(`/me endpoint returned ${res.status}`);

  const data = await res.json();
  const mini = data?.included?.find((e: any) => e["$type"]?.includes("MiniProfile"));
  const publicId = mini?.publicIdentifier;
  if (!publicId) throw new Error("Could not determine your LinkedIn profile ID.");

  return {
    profileUrl: `https://www.linkedin.com/in/${publicId}/`,
    publicId,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — DOM scraping with innerText parsing
// ---------------------------------------------------------------------------

const DATE_RE = /(?:jan|fév|feb|mar|avr|apr|mai|may|jun|juin|jul|juil|aug|aoû|sep|oct|nov|déc|dec)\.?\s+\d{4}\s*[-–]\s*(?:(?:jan|fév|feb|mar|avr|apr|mai|may|jun|juin|jul|juil|aug|aoû|sep|oct|nov|déc|dec)\.?\s+\d{4}|aujourd'hui|present|présent|actuel)/i;
const DURATION_RE = /^\d+\s+(?:an|ans|mois|yr|yrs|mo|mos)/i;

async function scrapeBasics(page: Page): Promise<{
  name: string; title: string; location: string; summary: string;
}> {
  return page.evaluate(`(() => {
    var title = document.title || "";
    var name = title.replace(/\\s*\\|\\s*LinkedIn.*$/, "").replace(/\\s*[-–]\\s*LinkedIn.*$/, "").trim();

    var sections = document.querySelectorAll("main section");
    var headline = "";
    var location = "";
    var summary = "";

    for (var i = 0; i < sections.length; i++) {
      var text = sections[i].innerText || "";
      var lines = text.split("\\n").map(function(l) { return l.trim(); }).filter(Boolean);

      if (!headline && lines.length > 0) {
        for (var j = 0; j < lines.length; j++) {
          if (lines[j] === name || lines[j].replace(/[^\\w\\s]/g, "").trim() === name.replace(/[^\\w\\s]/g, "").trim()) {
            if (j + 1 < lines.length) headline = lines[j + 1];
            for (var k = j + 2; k < Math.min(j + 6, lines.length); k++) {
              if (/suisse|france|switzerland|belgique|canada|luxembourg|paris|lyon|genève|lausanne|zurich|,/i.test(lines[k]) && !location) {
                location = lines[k];
                break;
              }
            }
            break;
          }
        }
      }

      if (!summary && (text.startsWith("Infos") || text.startsWith("About"))) {
        var idx = lines.indexOf("Infos");
        if (idx < 0) idx = lines.indexOf("About");
        if (idx >= 0 && idx + 1 < lines.length) {
          var summaryLines = [];
          for (var m = idx + 1; m < lines.length; m++) {
            if (/^(Compétences|Skills|Top skills|Voir plus|See more)/.test(lines[m])) break;
            summaryLines.push(lines[m]);
          }
          summary = summaryLines.join("\\n");
        }
      }
    }

    return { name: name, title: headline, location: location, summary: summary };
  })()`) as unknown as { name: string; title: string; location: string; summary: string };
}

async function scrapeExperience(page: Page, publicId: string): Promise<Experience[]> {
  await loadDetailPage(page, publicId, "experience");
  const items = await extractListItems(page);

  const experiences: Experience[] = [];
  for (const lines of items) {
    if (lines.length < 2) continue;

    // Find the line containing a date range
    let dateLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (DATE_RE.test(lines[i])) {
        dateLineIdx = i;
        break;
      }
    }

    if (dateLineIdx < 0) continue;

    const dateLine = lines[dateLineIdx];
    const dateMatch = dateLine.match(DATE_RE);
    if (!dateMatch) continue;

    // Position title is typically lines[0], company is lines[1] (before the date line)
    // Or if there's a grouped company, the structure differs
    let position = lines[0] ?? "";
    let company = "";

    if (dateLineIdx >= 2) {
      company = lines[1] ?? "";
    } else if (dateLineIdx === 1) {
      // Date is on line 1, so line 0 is position, no separate company line
      company = "";
    }

    // Clean up: company line may have "· Temps plein" or "Full-time" appended
    company = company.replace(/\s*·\s*.*$/, "").replace(/\s*Temps plein.*$/i, "").replace(/\s*Full.time.*$/i, "").trim();

    // Extract location — line after date/duration
    let location: string | undefined;
    let descStartIdx = dateLineIdx + 1;

    for (let i = dateLineIdx + 1; i < Math.min(dateLineIdx + 3, lines.length); i++) {
      if (DURATION_RE.test(lines[i])) {
        descStartIdx = i + 1;
        continue;
      }
      if (/suisse|switzerland|france|belgique|canada|luxembourg|remote|hybrid|sur site|on-site/i.test(lines[i]) && !location) {
        location = lines[i];
        descStartIdx = i + 1;
        continue;
      }
      if (/,/.test(lines[i]) && lines[i].length < 60 && !location) {
        location = lines[i];
        descStartIdx = i + 1;
        continue;
      }
      break;
    }

    // Description: remaining lines (skip UI artifacts like "Améliorer avec l'IA")
    const descLines: string[] = [];
    for (let i = descStartIdx; i < lines.length; i++) {
      const l = lines[i];
      if (/^(Améliorer avec l'IA|Enhance with AI|Voir plus|See more|Compétences|Skills|\d+ recommandation)/.test(l)) continue;
      if (l.length < 3) continue;
      descLines.push(l);
    }

    const { startDate, endDate } = parseDateRange(dateMatch[0]);

    experiences.push({
      company,
      position,
      location,
      startDate,
      endDate,
      summary: descLines.join("\n"),
      highlights: [],
      technologies: [],
    });
  }

  return experiences;
}

async function scrapeEducation(page: Page, publicId: string): Promise<Education[]> {
  await loadDetailPage(page, publicId, "education");
  const items = await extractListItems(page);

  const results: Education[] = [];
  for (const lines of items) {
    if (lines.length < 1) continue;

    let dateLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/\d{4}\s*[-–]\s*\d{4}/.test(lines[i]) || DATE_RE.test(lines[i])) {
        dateLineIdx = i;
        break;
      }
    }

    if (dateLineIdx < 0) continue;

    const institution = lines[0] ?? "";
    const studyInfo = dateLineIdx >= 2 ? lines[1] ?? "" : "";
    const parts = studyInfo.split(",").map((s) => s.trim());

    const { startDate, endDate } = parseDateRange(lines[dateLineIdx]);

    results.push({
      institution,
      studyType: parts[0] ?? "",
      area: parts.slice(1).join(", "),
      startDate,
      endDate,
      highlights: [],
    });
  }

  return results;
}

async function scrapeSkills(page: Page, publicId: string): Promise<string[]> {
  await loadDetailPage(page, publicId, "skills");
  const items = await extractListItems(page);

  const skills: string[] = [];
  const seen = new Set<string>();

  for (const lines of items) {
    if (lines.length < 1) continue;
    const name = lines[0];
    if (!name || name.length > 60 || /^\d/.test(name) || /endorsement|recommandation/i.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    skills.push(name);
  }

  return skills;
}

async function scrapeCertifications(page: Page, publicId: string): Promise<Certification[]> {
  await loadDetailPage(page, publicId, "certifications");
  const items = await extractListItems(page);

  const results: Certification[] = [];
  for (const lines of items) {
    if (lines.length < 1) continue;
    const name = lines[0] ?? "";
    const issuer = lines.length >= 2 ? lines[1].replace(/\s*·\s*.*$/, "").trim() : "";
    let date = "";
    for (const l of lines) {
      if (/\d{4}/.test(l)) {
        date = l;
        break;
      }
    }
    if (!name) continue;
    results.push({ name, issuer, date: extractFirstDate(date), url: undefined });
  }

  return results;
}

async function scrapeLanguages(page: Page, publicId: string): Promise<{ language: string; fluency: string }[]> {
  await loadDetailPage(page, publicId, "languages");
  const items = await extractListItems(page);

  const results: { language: string; fluency: string }[] = [];
  for (const lines of items) {
    if (lines.length < 1) continue;
    const language = lines[0] ?? "";
    const proficiency = lines.length >= 2 ? lines[1] : "";
    if (!language || /^\d/.test(language)) continue;
    results.push({ language, fluency: mapProficiency(proficiency) });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Date & text helpers
// ---------------------------------------------------------------------------

function parseDateRange(dateRange: string): { startDate: string; endDate?: string } {
  if (!dateRange) return { startDate: "" };

  const normalized = dateRange.replace(/–/g, "-");
  const parts = normalized.split(/\s*-\s*/).map((s) => s.trim());

  const monthMap: Record<string, string> = {
    jan: "01", fév: "02", feb: "02", mar: "03", avr: "04", apr: "04",
    mai: "05", may: "05", jun: "06", juin: "06", jul: "07", juil: "07",
    aug: "08", aoû: "08", sep: "09", oct: "10", nov: "11", déc: "12", dec: "12",
  };

  const parseOne = (str: string): string => {
    const tokens = str.toLowerCase().replace(/\./g, "").split(/[\s,]+/).filter(Boolean);
    let year = "";
    let month = "";
    for (const token of tokens) {
      if (/^\d{4}$/.test(token)) year = token;
      else if (monthMap[token.slice(0, 3)]) month = monthMap[token.slice(0, 3)];
    }
    if (year && month) return `${year}-${month}`;
    if (year) return year;
    return "";
  };

  const startDate = parseOne(parts[0]);
  const endPart = parts[1] ?? "";
  if (!endPart || /présent|present|actuel|current|aujourd'hui|today/i.test(endPart)) {
    return { startDate };
  }
  return { startDate, endDate: parseOne(endPart) };
}

function extractFirstDate(str: string): string {
  const match = str.match(/(?:\w+\.?\s+)?\d{4}/);
  if (!match) return "";
  return parseDateRange(match[0]).startDate;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let browser;
  try {
    const { context, page } = await launchAndLogin();
    browser = page.context().browser();

    const { profileUrl, publicId } = await resolveOwnProfile(context);
    console.log(`Profile: ${publicId}`);
    console.log(`URL: ${profileUrl}\n`);

    // Basics + photo
    console.log("Scraping profile page…");
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await scrollToBottom(page);

    const basics = await scrapeBasics(page);
    console.log(`  Name: ${basics.name}`);
    console.log(`  Title: ${basics.title}`);
    console.log(`  Location: ${basics.location}`);
    console.log(`  Summary: ${basics.summary.slice(0, 80)}${basics.summary.length > 80 ? "…" : ""}`);

    const photoPath = await saveProfilePhoto(page);

    // Experience
    console.log("\nScraping experience…");
    const experience = await scrapeExperience(page, publicId);
    console.log(`  Found ${experience.length} positions`);
    for (const exp of experience) {
      console.log(`    - ${exp.position} @ ${exp.company} (${exp.startDate})`);
    }

    // Education
    console.log("Scraping education…");
    const education = await scrapeEducation(page, publicId);
    console.log(`  Found ${education.length} entries`);

    // Skills
    console.log("Scraping skills…");
    const skillNames = await scrapeSkills(page, publicId);
    console.log(`  Found ${skillNames.length} skills`);

    // Certifications
    console.log("Scraping certifications…");
    const certifications = await scrapeCertifications(page, publicId);
    console.log(`  Found ${certifications.length} certifications`);

    // Languages
    console.log("Scraping languages…");
    const languages = await scrapeLanguages(page, publicId);
    console.log(`  Found ${languages.length} languages`);

    await saveCookies(context);
    await browser?.close();
    browser = null;

    // Build resume
    const existingResume = loadExistingResume();

    const resume: Resume = {
      basics: {
        name: basics.name || existingResume.basics?.name || "Your Name",
        title: basics.title || existingResume.basics?.title || "Your Title",
        email: existingResume.basics?.email ?? "",
        phone: existingResume.basics?.phone,
        location: basics.location || existingResume.basics?.location || "",
        summary: basics.summary || existingResume.basics?.summary || "",
        photo: photoPath || existingResume.basics?.photo,
        profiles: [
          { network: "LinkedIn", url: `https://www.linkedin.com/in/${publicId}`, username: publicId },
          ...(existingResume.basics?.profiles?.filter((p) => p.network !== "LinkedIn") ?? []),
        ],
      },
      experience: experience.length > 0 ? experience : existingResume.experience ?? [],
      education: education.length > 0 ? education : existingResume.education ?? [],
      skills: skillNames.length > 0 ? categorizeSkills(skillNames) : existingResume.skills ?? [],
      projects: existingResume.projects ?? [],
      certifications: certifications.length > 0 ? certifications : existingResume.certifications ?? [],
      languages: languages.length > 0 ? languages : existingResume.languages ?? [],
    };

    console.log("");
    writeResume(resume);
  } catch (err) {
    console.error("\n✗ Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser?.close().catch(() => {});
  }
}

main();
