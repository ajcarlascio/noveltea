import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <section className="page">
      <h1>Not found</h1>
      <p className="page__note">
        That page does not exist. <Link to="/projects">Back to your projects</Link>.
      </p>
    </section>
  );
}
