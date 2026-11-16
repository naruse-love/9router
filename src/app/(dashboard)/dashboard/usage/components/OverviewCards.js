"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      <Card className="flex min-w-0 flex-col items-center justify-center text-center gap-1 px-2 py-2.5 sm:px-4 sm:py-3">
        <span className="text-text-muted text-[10px] sm:text-sm uppercase font-semibold leading-tight">Total Requests</span>
        <span className="w-full truncate text-base sm:text-lg font-bold xl:text-xl" title={fmt(stats.totalRequests)}>{fmt(stats.totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center justify-center text-center gap-1 px-2 py-2.5 sm:px-4 sm:py-3">
        <span className="text-text-muted text-[10px] sm:text-sm uppercase font-semibold leading-tight">Total Input Tokens</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-primary xl:text-xl" title={fmt(stats.totalPromptTokens)}>{fmt(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center justify-center text-center gap-1 px-2 py-2.5 sm:px-4 sm:py-3">
        <span className="text-text-muted text-[10px] sm:text-sm uppercase font-semibold leading-tight">Cached Tokens</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-info xl:text-xl" title={fmt(stats.totalCachedTokens)}>{fmt(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center justify-center text-center gap-1 px-2 py-2.5 sm:px-4 sm:py-3">
        <span className="text-text-muted text-[10px] sm:text-sm uppercase font-semibold leading-tight">Output Tokens</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-success xl:text-xl" title={fmt(stats.totalCompletionTokens)}>{fmt(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="col-span-2 flex min-w-0 flex-col items-center justify-center text-center gap-1 px-2 py-2.5 sm:px-4 sm:py-3 sm:col-span-2 md:col-span-1">
        <span className="text-text-muted text-[10px] sm:text-sm uppercase font-semibold leading-tight">Est. Cost</span>
        <span className="w-full truncate text-base sm:text-lg font-bold text-warning xl:text-xl" title={`~${fmtCost(stats.totalCost)}`}>~{fmtCost(stats.totalCost)}</span>
        <span className="text-[9px] sm:text-[10px] text-text-muted leading-tight">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
