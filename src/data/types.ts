export interface Resume {
  basics: Basics;
  experience: Experience[];
  education: Education[];
  skills: SkillCategory[];
  projects: Project[];
  certifications: Certification[];
  languages: Language[];
}

export interface Basics {
  name: string;
  title: string;
  email: string;
  phone?: string;
  location: string;
  summary: string;
  photo?: string;
  profiles: Profile[];
}

export interface Profile {
  network: string;
  url: string;
  username?: string;
}

export interface Experience {
  company: string;
  companyLogo?: string;
  companyDomain?: string;
  position: string;
  location?: string;
  startDate: string;
  endDate?: string;
  summary: string;
  highlights: string[];
  technologies?: string[];
}

export interface Education {
  institution: string;
  area: string;
  studyType: string;
  startDate: string;
  endDate?: string;
  score?: string;
  highlights?: string[];
}

export interface SkillCategory {
  category: string;
  items: string[];
}

export interface Project {
  name: string;
  description: string;
  url?: string;
  technologies: string[];
  highlights?: string[];
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
  url?: string;
}

export interface Language {
  language: string;
  fluency: string;
}
