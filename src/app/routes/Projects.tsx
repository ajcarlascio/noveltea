import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDatabase } from "@/app/db/DatabaseContext";
import { createProject } from "@/data/binder";
import { listProjects, type Project } from "@/data/projects";
import { StorageWarning } from "@/ui/StorageWarning";

export function Projects() {
  const { db } = useDatabase();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

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
  }, [db, reloadToken]);

  const onCreate = () => {
    void (async () => {
      try {
        await createProject(db, "Untitled project");
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      setReloadToken((n) => n + 1);
    })();
  };

  return (
    <section className="page">
      <h1>Projects</h1>
      <StorageWarning />

      {error !== null && (
        <p className="page__note" role="alert">
          Could not read your projects: {error}
        </p>
      )}

      <p>
        <button type="button" className="button" onClick={onCreate}>
          New project
        </button>
      </p>

      {/* No spinner: this reads the local replica, not the network. On a cold start
          the worker queues the read and answers it in milliseconds; announcing a
          wait that is not happening is worse than a blank moment. */}
      {error === null && projects !== null && projects.length === 0 && (
        <p className="page__note">No projects yet. Create one to open its binder.</p>
      )}

      {projects !== null && projects.length > 0 && (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <Link to={`/projects/${project.id}`}>{project.title}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
