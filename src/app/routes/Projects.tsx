import { useEffect, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { listProjects, type Project } from "@/data/projects";
import { StorageWarning } from "@/ui/StorageWarning";

export function Projects() {
  const { db } = useDatabase();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    listProjects(db)
      .then((rows) => {
        if (current) setProjects(rows);
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    // Guards against a resolved read from a previous database landing on a new one.
    return () => {
      current = false;
    };
  }, [db]);

  return (
    <section className="page">
      <h1>Projects</h1>
      <StorageWarning />

      {error !== null && (
        <p className="page__note" role="alert">
          Could not read your projects: {error}
        </p>
      )}

      {/* No spinner: this reads the local replica, not the network. On a cold start
          the worker queues the read and answers it in milliseconds; announcing a
          wait that is not happening is worse than a blank moment. */}
      {error === null && projects !== null && projects.length === 0 && (
        <p className="page__note">
          No projects yet. Sign in to a server to pull your work down, or create one once
          the binder exists.
        </p>
      )}

      {projects !== null && projects.length > 0 && (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>{project.title}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
