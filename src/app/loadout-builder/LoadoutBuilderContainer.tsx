import ShowPageLoading from 'app/dim-ui/ShowPageLoading';
import { t } from 'app/i18next-t';
import { allItemsSelector } from 'app/inventory/selectors';
import { useLoadStores } from 'app/inventory/store/hooks';
import { setSearchQuery } from 'app/shell/actions';
import ErrorPanel from 'app/shell/ErrorPanel';
import { useThunkDispatch } from 'app/store/thunk-dispatch';
import React, { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { createSelector } from 'reselect';
import { DestinyAccount } from '../accounts/destiny-account';
import { useInitialLoadout } from './initial-loadout';
import LoadoutBuilder from './LoadoutBuilder';

const disabledDueToMaintenanceSelector = createSelector(
  allItemsSelector,
  (items) => items.length > 0 && items.every((item) => item.missingSockets)
);

/**
 * The Loadout Optimizer provides an interface for editing the armor of a loadout to pick optimal armor sets with mods included.
 *
 * This container makes sure stores are loaded, and either parses or creates the initial loadout the LO will be working with.
 */
export default function LoadoutBuilderContainer({ account }: { account: DestinyAccount }) {
  const storesLoaded = useLoadStores(account);
  const disabledDueToMaintenance = useSelector(disabledDueToMaintenanceSelector);

  // Get a starting loadout for the LO based on URL params and such
  const [initialLoadout] = useInitialLoadout();
  const query = initialLoadout?.parameters?.query ?? '';
  useSyncSearchQuery(query);

  if (!storesLoaded) {
    return <ShowPageLoading message={t('Loading.Profile')} />;
  }

  // Don't even bother showing the tool when Bungie has shut off sockets.
  if (disabledDueToMaintenance) {
    return (
      <div className="dim-page">
        <ErrorPanel title={t('LoadoutBuilder.DisabledDueToMaintenance')} showTwitters />
      </div>
    );
  }

  // TODO: key off the URL params? Loadout ID?
  return <LoadoutBuilder account={account} initialLoadout={initialLoadout} />;
}

/**
 * Set the global search query to the provided string unless it's empty.
 */
function useSyncSearchQuery(query: string) {
  const dispatch = useThunkDispatch();
  useEffect(() => {
    if (query) {
      dispatch(setSearchQuery(query));
    }
  }, [dispatch, query]);
}
