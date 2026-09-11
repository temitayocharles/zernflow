import Link from "next/link";
export function Pagination({
  page,
  total,
  search = "",
}: {
  page: number;
  total: number;
  search?: string;
}) {
  return (
    <nav aria-label="Result pages" className="flex items-center gap-4 text-sm">
      {page > 0 && (
        <Link
          className="underline"
          href={`?${new URLSearchParams({ page: String(page - 1), q: search })}`}
        >
          Previous page
        </Link>
      )}
      <span>
        Page {page + 1} · {total} records
      </span>
      {(page + 1) * 50 < total && (
        <Link
          className="underline"
          href={`?${new URLSearchParams({ page: String(page + 1), q: search })}`}
        >
          Next page
        </Link>
      )}
    </nav>
  );
}
