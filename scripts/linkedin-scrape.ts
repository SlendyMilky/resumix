import { chromium, type BrowserContext, type Page } from "playwright";
import type { Resume, Experience, Education, Certification, Profile } from "../src/data/types.js";
import {
  loadExistingResume,
  writeResume,
  downloadImage,
  formatVoyagerDate,
  categorizeSkills,
  mapProficiency,
} from "./linkedin-shared.js";

const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;
const SCROLL_PAUSE_MS = 800;
const NETWORK_IDLE_MS = 3000;

interface CapturedData {
  included: any[];
  profileUrn: string;
  publicId: string;
}

// ---------------------------------------------------------------------------
// Phase 1 — Login via Playwright
// ---------------------------------------------------------------------------

async function launchAndLogin(): Promise<{ context: BrowserContext; page: Page }> {
  console.log("Launching browser for LinkedIn login…");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  await page.goto("https://www.linkedin.com/login");
  console.log("Please log in to LinkedIn in the browser window.");
  console.log(`You have ${LOGIN_TIMEOUT_MS / 1000}s to complete the login.\n`);

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
  return { context, page };
}

// ---------------------------------------------------------------------------
// Phase 2 — Navigate, intercept & capture only own profile data
// ---------------------------------------------------------------------------

function setupInterceptor(page: Page, captured: CapturedData): void {
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/voyager/api/")) return;
    if (response.status() < 200 || response.status() >= 300) return;

    try {
      const json = await response.json();
      const included = json?.included ?? json?.data?.included ?? [];
      if (Array.isArray(included) && included.length > 0) {
        captured.included.push(...included);
      }
      if (json?.data && !Array.isArray(json.data)) {
        captured.included.push(json.data);
      }
    } catch {
      // Not JSON — ignore
    }
  });
}

async function scrollToBottom(page: Page): Promise<void> {
  let previousHeight = 0;
  let stableCount = 0;

  while (stableCount < 3) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
    await page.waitForTimeout(SCROLL_PAUSE_MS);
  }
}

async function resolveOwnProfile(context: BrowserContext): Promise<{ profileUrl: string; profileUrn: string; publicId: string }> {
  const cookies = await context.cookies("https://www.linkedin.com");
  const liAt = cookies.find((c) => c.name === "li_at")?.value;
  const jsessionId = cookies.find((c) => c.name === "JSESSIONID")?.value?.replace(/"/g, "");

  if (!liAt || !jsessionId) {
    throw new Error("Missing LinkedIn cookies after login.");
  }

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
  const profileUrn = mini?.entityUrn ?? mini?.objectUrn ?? "";

  if (!publicId) throw new Error("Could not determine your LinkedIn profile ID.");

  return {
    profileUrl: `https://www.linkedin.com/in/${publicId}/`,
    profileUrn,
    publicId,
  };
}

async function navigateAndCapture(context: BrowserContext, page: Page): Promise<CapturedData> {
  console.log("Finding your profile…");
  const { profileUrl, profileUrn, publicId } = await resolveOwnProfile(context);
  console.log(`  Profile: ${publicId}`);
  console.log(`  URN: ${profileUrn}\n`);

  const captured: CapturedData = { included: [], profileUrn, publicId };
  setupInterceptor(page, captured);

  // Navigate to own profile page
  console.log("Loading profile page…");
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await scrollToBottom(page);
  await page.waitForTimeout(NETWORK_IDLE_MS);

  console.log(`  Captured ${captured.included.length} entities from profile page.`);

  // Only follow /details/ links that belong to OWN profile
  const showAllLinks = await page.$$(`a[href*="/in/${publicId}/details/"]`);
  const detailPaths = new Set<string>();
  for (const link of showAllLinks) {
    const href = await link.getAttribute("href");
    if (!href) continue;
    const fullUrl = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
    // Only include links that are under our own profile
    if (fullUrl.includes(`/in/${publicId}/`)) {
      detailPaths.add(fullUrl);
    }
  }

  if (detailPaths.size === 0) {
    // Fallback: try known detail section paths
    const knownSections = ["experience", "education", "skills", "certifications", "languages", "courses"];
    for (const section of knownSections) {
      detailPaths.add(`https://www.linkedin.com/in/${publicId}/details/${section}/`);
    }
  }

  for (const detailUrl of detailPaths) {
    const section = detailUrl.split("/details/")[1]?.split(/[/?]/)[0] ?? "unknown";
    console.log(`  Loading detail section: ${section}…`);
    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      await scrollToBottom(page);
      await page.waitForTimeout(2000);
    } catch {
      console.log(`    Could not load ${section}, skipping.`);
    }
  }

  console.log(`  Total captured entities: ${captured.included.length}\n`);
  return captured;
}

// ---------------------------------------------------------------------------
// Phase 3 — Map captured data to Resume schema (filtered to own profile)
// ---------------------------------------------------------------------------

function dedup(items: any[]): any[] {
  const seen = new Map<string, any>();
  for (const item of items) {
    const key = item.entityUrn ?? JSON.stringify(item).slice(0, 200);
    if (!seen.has(key)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

function findByType(included: any[], typeFragment: string): any[] {
  return included.filter((e: any) => {
    const t = e["$type"] ?? e["$recipeType"] ?? "";
    return t.includes(typeFragment);
  });
}

/**
 * Checks if an entity belongs to the given profile URN.
 * Entities reference their owning profile in different ways depending on the API version.
 */
function belongsToProfile(entity: any, profileUrn: string): boolean {
  if (!profileUrn) return true;

  // The profile URN ID (last segment after the last colon)
  const urnId = profileUrn.split(":").pop() ?? "";
  if (!urnId) return true;

  const json = JSON.stringify(entity);
  return json.includes(urnId);
}

function extractImageUrl(picture: any): string | null {
  if (!picture) return null;

  const tryArtifacts = (artifacts: any[], rootUrl: string): string | null => {
    if (!artifacts?.length) return null;
    const largest = artifacts.reduce((a: any, b: any) =>
      (a.width ?? a.expiresAt ?? 0) > (b.width ?? b.expiresAt ?? 0) ? a : b
    );
    return (rootUrl ?? "") + (largest.fileIdentifyingUrlPathSegment ?? "");
  };

  const formats = [
    { artifacts: picture?.displayImageReference?.vectorImage?.artifacts, root: picture?.displayImageReference?.vectorImage?.rootUrl },
    { artifacts: picture?.displayImageWithExpiryReference?.vectorImage?.artifacts, root: picture?.displayImageWithExpiryReference?.vectorImage?.rootUrl },
    { artifacts: picture?.artifacts, root: picture?.rootUrl ?? "" },
    { artifacts: picture?.vectorImage?.artifacts, root: picture?.vectorImage?.rootUrl },
    { artifacts: picture?.image?.["com.linkedin.common.VectorImage"]?.artifacts, root: picture?.image?.["com.linkedin.common.VectorImage"]?.rootUrl },
  ];

  for (const fmt of formats) {
    const result = tryArtifacts(fmt.artifacts, fmt.root ?? "");
    if (result) return result;
  }

  if (Array.isArray(picture?.display)) {
    const largest = picture.display.reduce((a: any, b: any) =>
      (a.width ?? 0) > (b.width ?? 0) ? a : b
    );
    return largest?.url ?? null;
  }

  return null;
}

async function mapCapturedToResume(captured: CapturedData): Promise<Resume> {
  const allIncluded = dedup(captured.included);
  const { profileUrn, publicId } = captured;
  const existingResume = loadExistingResume();

  // --- Find the authenticated user's Profile entity ---
  const profileEntities = findByType(allIncluded, "Profile");
  const profile = profileEntities.find(
    (p: any) => p.publicIdentifier === publicId && p.firstName
  ) ?? profileEntities.find(
    (p: any) => belongsToProfile(p, profileUrn) && p.firstName
  ) ?? profileEntities[0];

  const firstName = profile?.firstName ?? "";
  const lastName = profile?.lastName ?? "";
  const headline = profile?.headline ?? "";
  const locationName = profile?.locationName ?? profile?.geoLocationName ?? "";
  const summary = profile?.summary ?? "";

  // Photo
  let photoPath = existingResume.basics?.photo ?? undefined;
  const photoUrl =
    extractImageUrl(profile?.profilePicture) ??
    extractImageUrl(profile?.picture);
  if (photoUrl) {
    const downloaded = await downloadImage(photoUrl, "profile.jpg");
    if (downloaded) photoPath = downloaded;
  }

  const linkedInUrl = `https://www.linkedin.com/in/${publicId}`;
  const profiles: Profile[] = [
    { network: "LinkedIn", url: linkedInUrl, username: publicId },
    ...(existingResume.basics?.profiles?.filter((p) => p.network !== "LinkedIn") ?? []),
  ];

  // --- Experience: only entities belonging to our profile ---
  const allPositions = findByType(allIncluded, "Position");
  const myPositions = allPositions.filter((p) => belongsToProfile(p, profileUrn));
  console.log(`  Positions: ${myPositions.length} (filtered from ${allPositions.length})`);

  const experience: Experience[] = myPositions.length > 0
    ? await Promise.all(myPositions.map(async (pos: any): Promise<Experience> => {
        const companyName: string = pos.companyName ?? pos.company?.miniCompany?.name ?? pos.company?.name ?? "";
        const universalName = pos.company?.miniCompany?.universalName ?? pos.companyUrn?.split(":")?.pop();
        const companyDomain = universalName ? `${universalName}.com` : undefined;

        let companyLogo: string | undefined;
        const logoUrl =
          extractImageUrl(pos.company?.logo) ??
          extractImageUrl(pos.company?.miniCompany?.logo) ??
          extractImageUrl(pos.companyLogo);
        if (logoUrl) {
          const safeName = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
          const downloaded = await downloadImage(logoUrl, `companies/${safeName}.jpg`);
          if (downloaded) companyLogo = downloaded;
        }

        return {
          company: companyName,
          companyLogo,
          companyDomain,
          position: pos.title ?? "",
          location: pos.locationName ?? pos.geoLocationName,
          startDate: formatVoyagerDate(pos.timePeriod?.startDate ?? pos.startDate),
          endDate: (pos.timePeriod?.endDate ?? pos.endDate)
            ? formatVoyagerDate(pos.timePeriod?.endDate ?? pos.endDate)
            : undefined,
          summary: pos.description ?? "",
          highlights: [],
          technologies: [],
        };
      }))
    : existingResume.experience ?? [];

  // --- Education ---
  const allEducation = findByType(allIncluded, "Education");
  const myEducation = allEducation.filter((e) => belongsToProfile(e, profileUrn));
  console.log(`  Education: ${myEducation.length} (filtered from ${allEducation.length})`);

  const education: Education[] = myEducation.length > 0
    ? myEducation.map((edu: any): Education => ({
        institution: edu.schoolName ?? edu.school?.schoolName ?? edu.school?.name ?? "",
        area: edu.fieldOfStudy ?? "",
        studyType: edu.degreeName ?? "",
        startDate: formatVoyagerDate(edu.timePeriod?.startDate ?? edu.startDate),
        endDate: (edu.timePeriod?.endDate ?? edu.endDate)
          ? formatVoyagerDate(edu.timePeriod?.endDate ?? edu.endDate)
          : undefined,
        highlights: edu.activities ? [edu.activities] : [],
      }))
    : existingResume.education ?? [];

  // --- Skills ---
  const allSkills = findByType(allIncluded, "Skill");
  const mySkills = allSkills.filter((s) => belongsToProfile(s, profileUrn));
  const skillNames = [...new Set(mySkills.map((s: any) => s.name).filter(Boolean) as string[])];
  console.log(`  Skills: ${skillNames.length} (filtered from ${allSkills.length})`);

  const skills = skillNames.length > 0
    ? categorizeSkills(skillNames)
    : existingResume.skills ?? [];

  // --- Certifications ---
  const allCerts = findByType(allIncluded, "Certification");
  const myCerts = allCerts.filter((c) => belongsToProfile(c, profileUrn));
  console.log(`  Certifications: ${myCerts.length} (filtered from ${allCerts.length})`);

  const certifications: Certification[] = myCerts.length > 0
    ? myCerts.map((c: any): Certification => ({
        name: c.name ?? "",
        issuer: c.authority ?? "",
        date: formatVoyagerDate(c.timePeriod?.startDate) || formatVoyagerDate(c.timePeriod?.endDate),
        url: c.url ?? undefined,
      }))
    : existingResume.certifications ?? [];

  // --- Languages ---
  const allLangs = findByType(allIncluded, "Language");
  const myLangs = allLangs.filter((l) => belongsToProfile(l, profileUrn));
  console.log(`  Languages: ${myLangs.length} (filtered from ${allLangs.length})`);

  const languages = myLangs.length > 0
    ? myLangs.map((l: any) => ({
        language: l.name ?? "",
        fluency: mapProficiency(l.proficiency?.level ?? l.proficiency),
      }))
    : existingResume.languages ?? [];

  return {
    basics: {
      name: [firstName, lastName].filter(Boolean).join(" ") || existingResume.basics?.name || "Your Name",
      title: headline || existingResume.basics?.title || "Your Title",
      email: existingResume.basics?.email ?? "",
      phone: existingResume.basics?.phone,
      location: locationName || existingResume.basics?.location || "",
      summary: summary || existingResume.basics?.summary || "",
      photo: photoPath,
      profiles,
    },
    experience,
    education,
    skills,
    projects: existingResume.projects ?? [],
    certifications,
    languages,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let browser;
  try {
    const { context, page } = await launchAndLogin();
    browser = page.context().browser();

    const captured = await navigateAndCapture(context, page);

    await browser?.close();
    browser = null;

    console.log("Mapping to resume format…");
    const resume = await mapCapturedToResume(captured);

    const stats = [
      `experience: ${resume.experience.length}`,
      `education: ${resume.education.length}`,
      `skills: ${resume.skills.reduce((n, c) => n + c.items.length, 0)}`,
      `certifications: ${resume.certifications.length}`,
      `languages: ${resume.languages.length}`,
    ].join(", ");
    console.log(`\n  Summary — ${stats}`);

    writeResume(resume);
  } catch (err) {
    console.error("\n✗ Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser?.close().catch(() => {});
  }
}

main();
