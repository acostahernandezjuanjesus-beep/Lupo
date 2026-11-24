import { Pagination as CarbonPagination } from '@carbon/react';

// The server pages 50 at a time; don't offer sizes it doesn't accept.
export function Pagination({ total, page, onChange, disabled = false }: {
    total: number; page: number; onChange: (page: number) => void; disabled?: boolean;
}) {
    return <CarbonPagination totalItems={total} page={page} pageSize={50} pageSizes={[50]}
        pageSizeInputDisabled disabled={disabled} onChange={({ page }) => onChange(page)}
        itemsPerPageText="Per page:" pageNumberText="Page" backwardText="Previous page" forwardText="Next page"
        pageRangeText={(_, total) => `of ${total} pages`} pageSelectLabelText={() => 'Page'}
        itemRangeText={(min, max, total) => `${min}–${max} of ${total}`} />;
}
