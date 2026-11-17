import type { HarborCatalogSupportEntry } from "@harbor/attempt-protocol";

export function SessionCatalogSupportEntries(props: { entries: HarborCatalogSupportEntry[] }) {
  return (
    <>
      {props.entries.map((entry) => (
        <div class="media-support-entry" key={entry.key}>
          <p>
            <strong>{entry.label}</strong>
            {entry.language ? ` · ${entry.language}` : ""}
            {entry.mediaType ? ` · ${entry.mediaType}` : ""}
          </p>
          {entry.text && <p>{entry.text}</p>}
          {entry.url ? (
            <a href={entry.url} target="_blank" rel="noreferrer">
              {entry.href}
            </a>
          ) : entry.href ? (
            <p>{entry.href}</p>
          ) : null}
        </div>
      ))}
    </>
  );
}
