import { Filter, Search } from 'lucide-react';
import Button from '../common/Button.jsx';

function getOptionValue(option) {
  return typeof option === 'string' ? option : option.value;
}

function getOptionLabel(option) {
  if (typeof option === 'string') {
    return option.charAt(0).toUpperCase() + option.slice(1);
  }

  return option.label;
}

function SelectFilter({ includeAll = true, label, value, onChange, options }) {
  return (
    <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
      >
        {includeAll ? <option value="all">All</option> : null}
        {options.map((option) => (
          <option key={getOptionValue(option)} value={getOptionValue(option)}>
            {getOptionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateFilter({ label, value, onChange }) {
  return (
    <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {label}
      <input
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
        type="datetime-local"
      />
    </label>
  );
}

export default function AlertFilters({
  filters,
  onFilterChange,
  onReset,
  serviceOptions,
  priorityOptions,
  statusOptions,
  sourceOptions,
  stateOptions,
  severityOptions,
  environmentOptions,
  classificationOptions,
  sortOptions,
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-4">
        <label className="relative block">
          <span className="sr-only">Search alerts</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={filters.search}
            onChange={(event) => onFilterChange('search', event.target.value)}
            className="h-11 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-2 focus:ring-cyan-100"
            placeholder="Search by alert ID, service, owner, or title"
            type="search"
          />
        </label>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SelectFilter
              label="Priority"
              value={filters.priority}
              onChange={(value) => onFilterChange('priority', value)}
              options={priorityOptions}
            />
            <SelectFilter
              label="Severity"
              value={filters.severity}
              onChange={(value) => onFilterChange('severity', value)}
              options={severityOptions}
            />
            <SelectFilter
              label="Service"
              value={filters.service}
              onChange={(value) => onFilterChange('service', value)}
              options={serviceOptions}
            />
            <SelectFilter
              label="Environment"
              value={filters.environment}
              onChange={(value) => onFilterChange('environment', value)}
              options={environmentOptions}
            />
            <SelectFilter
              label="Source"
              value={filters.source}
              onChange={(value) => onFilterChange('source', value)}
              options={sourceOptions}
            />
            <SelectFilter
              label="Status"
              value={filters.status}
              onChange={(value) => onFilterChange('status', value)}
              options={statusOptions}
            />
            <SelectFilter
              label="State"
              value={filters.state}
              onChange={(value) => onFilterChange('state', value)}
              options={stateOptions}
            />
            <SelectFilter
              label="Classification"
              value={filters.classification}
              onChange={(value) => onFilterChange('classification', value)}
              options={classificationOptions}
            />
            <SelectFilter
              label="Acknowledged"
              value={filters.acknowledged}
              onChange={(value) => onFilterChange('acknowledged', value)}
              options={[
                { value: 'acknowledged', label: 'Acknowledged' },
                { value: 'unacknowledged', label: 'Unacknowledged' },
              ]}
            />
            <SelectFilter
              includeAll={false}
              label="Sort"
              value={filters.sort}
              onChange={(value) => onFilterChange('sort', value)}
              options={sortOptions}
            />
            <DateFilter
              label="Created from"
              value={filters.createdFrom}
              onChange={(value) => onFilterChange('createdFrom', value)}
            />
            <DateFilter
              label="Created to"
              value={filters.createdTo}
              onChange={(value) => onFilterChange('createdTo', value)}
            />
            <DateFilter
              label="Updated from"
              value={filters.updatedFrom}
              onChange={(value) => onFilterChange('updatedFrom', value)}
            />
            <DateFilter
              label="Updated to"
              value={filters.updatedTo}
              onChange={(value) => onFilterChange('updatedTo', value)}
            />
          </div>

          <Button onClick={onReset} className="w-full xl:w-auto">
            <Filter className="h-4 w-4" aria-hidden="true" />
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
}
