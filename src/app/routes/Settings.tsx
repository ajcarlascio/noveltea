import { FontChooser } from "@/ui/FontChooser";
import { ThemeToggle } from "@/ui/ThemeToggle";
import { WritingSettings } from "@/ui/WritingSettings";

export function Settings() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <ThemeToggle />
      <FontChooser />
      <WritingSettings />
    </section>
  );
}
