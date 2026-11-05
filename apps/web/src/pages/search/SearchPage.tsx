import React, { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { InpulseApiClient } from "@generated/api";
import { SearchPageView } from "@features/search/SearchPageView";
import { navigatePrepared } from "@shared/routing/navigate-prepared";

export interface SearchPageProps {
  readonly client?: InpulseApiClient;
}

export const SearchPage: React.FC<SearchPageProps> = ({ client }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const initialQuery = searchParams.get("q") ?? "";

  const handleSubmit = useCallback(
    (query: string) => {
      const normalized = query.trim();
      setSearchParams(normalized ? { q: normalized } : {});
    },
    [setSearchParams],
  );

  const handleOpenResult = useCallback(
    (path: string) => {
      void navigatePrepared(navigate, path);
    },
    [navigate],
  );

  return (
    <SearchPageView
      initialQuery={initialQuery}
      onSubmit={handleSubmit}
      onOpenResult={handleOpenResult}
      {...(client ? { client } : {})}
    />
  );
};

export default SearchPage;
