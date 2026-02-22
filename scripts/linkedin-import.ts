import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import JSZip from "jszip";
import { parse } from "csv-parse/sync";
import type { Resume, Experience, Education, Certification, Profile } from "../src/data/types.js";
import {
  IMAGES_DIR,
  loadExistingResume,
  writeResume,
  formatLinkedInDate,
  categorizeSkills,
  mapProficiency,
} from "./linkedin-shared.js";

async function extractProfilePhoto(zip: JSZip): Promise<string | null> {
  const photoPatterns = [
    "profile photo",
    "profile_photo",
    "profilephoto",
    "photo.jpg",
    "photo.png",
    "photo.jpeg",
    "profile.jpg",
    "profile.png",
    "profile.jpeg",
  ];

  for (const [filePath, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const lower = filePath.toLowerCase();
    const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(lower);
    const matchesPattern = photoPatterns.some((p) => lower.includes(p));

    if (isImage && matchesPattern) {
      mkdirSync(IMAGES_DIR, { recursive: true });
      const ext = lower.split(".").pop() ?? "jpg";
      const outputPath = resolve(IMAGES_DIR, `profile.${ext}`);
      const data = await file.async("nodebuffer");
      writeFileSync(outputPath, data);
      console.log(`  Profile photo extracted: ${outputPath}`);
      return `/images/profile.${ext}`;
    }
  }

  return null;
}

interface LinkedInProfile {
  "First Name"?: string;
  "Last Name"?: string;
  "Maiden Name"?: string;
  "Address"?: string;
  "Birth Date"?: string;
  "Headline"?: string;
  "Summary"?: string;
  "Industry"?: string;
  "Zip Code"?: string;
  "Geo Location"?: string;
  "Twitter Handles"?: string;
  "Websites"?: string;
  "Instant Messengers"?: string;
}

interface LinkedInPosition {
  "Company Name"?: string;
  "Title"?: string;
  "Description"?: string;
  "Location"?: string;
  "Started On"?: string;
  "Finished On"?: string;
}

interface LinkedInEducation {
  "School Name"?: string;
  "Start Date"?: string;
  "End Date"?: string;
  "Notes"?: string;
  "Degree Name"?: string;
  "Activities"?: string;
}

interface LinkedInSkill {
  "Name"?: string;
}

interface LinkedInCertification {
  "Name"?: string;
  "Url"?: string;
  "Authority"?: string;
  "Started On"?: string;
  "Finished On"?: string;
  "License Number"?: string;
}

interface LinkedInLanguage {
  "Name"?: string;
  "Proficiency"?: string;
}

interface LinkedInEmail {
  "Email Address"?: string;
  "Confirmed"?: string;
  "Primary"?: string;
  "Updated On"?: string;
}

function parseCSV<T>(content: string): T[] {
  try {
    return parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    }) as T[];
  } catch {
    return [];
  }
}

async function findFile(zip: JSZip, patterns: string[]): Promise<string | null> {
  for (const [path] of Object.entries(zip.files)) {
    const lower = path.toLowerCase();
    if (patterns.some((p) => lower.includes(p.toLowerCase()))) {
      const content = await zip.files[path].async("string");
      if (content.trim()) return content;
    }
  }
  return null;
}

async function importLinkedIn(zipPath: string): Promise<void> {
  const absPath = resolve(zipPath);
  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  console.log(`Reading LinkedIn export: ${absPath}`);
  const data = readFileSync(absPath);
  const zip = await JSZip.loadAsync(data);

  console.log("Files in ZIP:");
  Object.keys(zip.files).forEach((f) => console.log(`  ${f}`));

  const existingResume = loadExistingResume();

  const profileCSV = await findFile(zip, ["Profile.csv", "profile.csv"]);
  const positionsCSV = await findFile(zip, ["Positions.csv", "positions.csv"]);
  const educationCSV = await findFile(zip, ["Education.csv", "education.csv"]);
  const skillsCSV = await findFile(zip, ["Skills.csv", "skills.csv"]);
  const certificationsCSV = await findFile(zip, ["Certifications.csv", "certifications.csv"]);
  const languagesCSV = await findFile(zip, ["Languages.csv", "languages.csv"]);
  const emailCSV = await findFile(zip, ["Email Addresses.csv", "email_addresses.csv", "email addresses.csv"]);

  const profile = profileCSV ? parseCSV<LinkedInProfile>(profileCSV) : [];
  const positions = positionsCSV ? parseCSV<LinkedInPosition>(positionsCSV) : [];
  const educationList = educationCSV ? parseCSV<LinkedInEducation>(educationCSV) : [];
  const skillsList = skillsCSV ? parseCSV<LinkedInSkill>(skillsCSV) : [];
  const certList = certificationsCSV ? parseCSV<LinkedInCertification>(certificationsCSV) : [];
  const langList = languagesCSV ? parseCSV<LinkedInLanguage>(languagesCSV) : [];
  const emailList = emailCSV ? parseCSV<LinkedInEmail>(emailCSV) : [];

  console.log(`\nParsed data:`);
  console.log(`  Profile entries: ${profile.length}`);
  console.log(`  Positions: ${positions.length}`);
  console.log(`  Education: ${educationList.length}`);
  console.log(`  Skills: ${skillsList.length}`);
  console.log(`  Certifications: ${certList.length}`);
  console.log(`  Languages: ${langList.length}`);
  console.log(`  Emails: ${emailList.length}`);

  const photoPath = await extractProfilePhoto(zip);
  if (photoPath) {
    console.log(`  Photo will be referenced as: ${photoPath}`);
  } else {
    console.log("  No profile photo found in ZIP.");
  }

  const profileData = profile[0] ?? {};
  const fullName = [profileData["First Name"], profileData["Last Name"]].filter(Boolean).join(" ");
  const primaryEmail = emailList.find((e) => e["Primary"] === "Yes")?.["Email Address"] ?? emailList[0]?.["Email Address"] ?? "";

  const profiles: Profile[] = [
    { network: "LinkedIn", url: "https://linkedin.com/in/your-profile", username: "" },
    ...(existingResume.basics?.profiles?.filter((p) => p.network !== "LinkedIn") ?? []),
  ];

  const resume: Resume = {
    basics: {
      name: fullName || existingResume.basics?.name || "Your Name",
      title: profileData["Headline"] || existingResume.basics?.title || "Your Title",
      email: primaryEmail || existingResume.basics?.email || "email@example.com",
      phone: existingResume.basics?.phone,
      location: profileData["Geo Location"] || profileData["Address"] || existingResume.basics?.location || "",
      summary: profileData["Summary"] || existingResume.basics?.summary || "",
      photo: photoPath || existingResume.basics?.photo,
      profiles,
    },

    experience: positions.length > 0
      ? positions.map((pos): Experience => ({
          company: pos["Company Name"] || "",
          position: pos["Title"] || "",
          location: pos["Location"],
          startDate: formatLinkedInDate(pos["Started On"]),
          endDate: pos["Finished On"] ? formatLinkedInDate(pos["Finished On"]) : undefined,
          summary: pos["Description"] || "",
          highlights: [],
          technologies: [],
        }))
      : existingResume.experience ?? [],

    education: educationList.length > 0
      ? educationList.map((edu): Education => ({
          institution: edu["School Name"] || "",
          area: edu["Notes"] || "",
          studyType: edu["Degree Name"] || "",
          startDate: formatLinkedInDate(edu["Start Date"]) || edu["Start Date"] || "",
          endDate: edu["End Date"] ? formatLinkedInDate(edu["End Date"]) : undefined,
          highlights: edu["Activities"] ? [edu["Activities"]] : [],
        }))
      : existingResume.education ?? [],

    skills: skillsList.length > 0
      ? categorizeSkills(skillsList.map((s) => s["Name"] || "").filter(Boolean))
      : existingResume.skills ?? [],

    projects: existingResume.projects ?? [],

    certifications: certList.length > 0
      ? certList.map((c): Certification => ({
          name: c["Name"] || "",
          issuer: c["Authority"] || "",
          date: formatLinkedInDate(c["Started On"]) || formatLinkedInDate(c["Finished On"]) || "",
          url: c["Url"] || undefined,
        }))
      : existingResume.certifications ?? [],

    languages: langList.length > 0
      ? langList.map((l) => ({
          language: l["Name"] || "",
          fluency: mapProficiency(l["Proficiency"]),
        }))
      : existingResume.languages ?? [],
  };

  writeResume(resume);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: yarn linkedin-import <path-to-linkedin-export.zip>");
  console.log();
  console.log("To get your LinkedIn data export:");
  console.log("  1. Go to LinkedIn Settings > Data privacy > Get a copy of your data");
  console.log("  2. Select the data you want (Positions, Education, Skills, etc.)");
  console.log("  3. Request the archive and wait for the email");
  console.log("  4. Download the ZIP file");
  console.log("  5. Run: yarn linkedin-import ./path/to/BasicProfile.zip");
  process.exit(0);
}

importLinkedIn(args[0]);
