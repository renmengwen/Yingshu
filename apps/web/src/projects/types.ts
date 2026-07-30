export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary extends Project {
  videoCount: number;
}

export interface Video {
  id: string;
  projectId: string;
  title: string;
  status: "draft";
  createdAt: number;
  updatedAt: number;
}

export interface PageCommonProps {
  navigate: (path: string) => void;
  onOpenSettings: () => void;
  themePreference: "system" | "light" | "dark";
  onThemeChange: (preference: "system" | "light" | "dark") => void;
}
