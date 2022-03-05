import {
  AssumeArmorMasterwork,
  LoadoutParameters,
  LockArmorEnergyType,
} from '@destinyitemmanager/dim-api-types';
import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { t } from 'app/i18next-t';
import { DimItem, PluggableInventoryItemDefinition } from 'app/inventory/item-types';
import { DimStore } from 'app/inventory/store-types';
import { getCurrentStore } from 'app/inventory/stores-helpers';
import { Loadout } from 'app/loadout-drawer/loadout-types';
import { showNotification } from 'app/notifications/notifications';
import { armor2PlugCategoryHashesByName } from 'app/search/d2-known-values';
import { emptyObject } from 'app/utils/empty';
import { DestinyClass } from 'bungie-api-ts/destiny2';
import _ from 'lodash';
import { useReducer } from 'react';
import { statFiltersFromLoadoutParamaters, statOrderFromLoadoutParameters } from './loadout-params';
import { ArmorSet, ArmorStatHashes, ExcludedItems, PinnedItems, StatFilters } from './types';

export interface LoadoutBuilderState {
  /**
   * The loadout we are choosing items for. This includes the LoadoutParameters
   * that specify mods, etc. A new loadout will be created here if one isn't
   * passed in.
   */
  loadout: Loadout;
  /** The user's preferred order of stats. */
  // We pull stat order out here into its own state field (synced with
  // LoadoutParameters#statConstraints) because the LoadoutParameters version
  // can't record the order of ignored stats
  statOrder: ArmorStatHashes[]; // stat hashes, including disabled stats
  // Is this another thing we need to keep around because it models stuff we don't have (e.g. preserving the min/max while a stat is disabled?)
  statFilters: Readonly<StatFilters>;
  pinnedItems: PinnedItems;
  excludedItems: ExcludedItems;
  selectedStoreId?: string;
  modPicker: {
    open: boolean;
    plugCategoryHashWhitelist?: number[];
  };
  compareSet?: ArmorSet;
}

export function warnMissingClass(classType: DestinyClass, defs: D2ManifestDefinitions) {
  const missingClassName = Object.values(defs.Class).find((c) => c.classType === classType)!
    .displayProperties.name;

  showNotification({
    type: 'error',
    title: t('LoadoutBuilder.MissingClass', { className: missingClassName }),
    body: t('LoadoutBuilder.MissingClassDescription'),
  });
}

interface InitializerArgs {
  defs: D2ManifestDefinitions;
  stores: DimStore[];
  initialLoadout: Loadout;
  customStatsByClass: {
    [key: number]: number[];
  };
  loStatOrderByClass: {
    [key: number]: ArmorStatHashes[];
  };
}

const lbStateInit = ({
  stores,
  initialLoadout,
  customStatsByClass,
  loStatOrderByClass,
}: InitializerArgs): LoadoutBuilderState => {
  const classType = initialLoadout.classType;
  const matchingClass =
    classType !== DestinyClass.Unknown
      ? stores.find((store) => store.classType === classType)
      : undefined;

  if (classType !== DestinyClass.Unknown && !matchingClass) {
    // This means we don't have a character that corresponds to this loadout's class
    // TODO: we won't be able to do much, but we can show the error on the page!
  }
  const selectedStoreId = (matchingClass ?? getCurrentStore(stores)!).id;

  const loadoutParameters: LoadoutParameters = initialLoadout.parameters ?? emptyObject();
  const statOrder = loadoutParameters.statConstraints
    ? statOrderFromLoadoutParameters(loadoutParameters)
    : statOrderFromSavedPreferences(loStatOrderByClass[classType]) ??
      statOrderFromCustomStats(customStatsByClass[classType]) ??
      statOrderFromLoadoutParameters(loadoutParameters);

  // TODO: just start saving ignored stats with LO params???
  // TODO: use negative stat hash for ignored stats?
  // TODO: backfill stat constraints from saved/custom stats order/enabled

  const statFilters = statFiltersFromLoadoutParamaters(loadoutParameters);

  return {
    loadout: initialLoadout,
    statOrder,
    pinnedItems: emptyObject(),
    excludedItems: emptyObject(),
    statFilters,
    selectedStoreId,
    modPicker: {
      open: false,
    },
  };
};

export type LoadoutBuilderAction =
  | { type: 'changeCharacter'; storeId: string }
  | { type: 'statFiltersChanged'; statFilters: LoadoutBuilderState['statFilters'] }
  | { type: 'sortOrderChanged'; sortOrder: LoadoutBuilderState['statOrder'] }
  | {
      type: 'assumeArmorMasterworkChanged';
      assumeArmorMasterwork: AssumeArmorMasterwork | undefined;
    }
  | { type: 'lockArmorEnergyTypeChanged'; lockArmorEnergyType: LockArmorEnergyType | undefined }
  | { type: 'pinItem'; item: DimItem }
  | { type: 'setPinnedItems'; items: DimItem[] }
  | { type: 'unpinItem'; item: DimItem }
  | { type: 'excludeItem'; item: DimItem }
  | { type: 'unexcludeItem'; item: DimItem }
  | { type: 'lockedModsChanged'; lockedMods: PluggableInventoryItemDefinition[] }
  | { type: 'removeLockedMod'; mod: PluggableInventoryItemDefinition }
  | { type: 'addGeneralMods'; mods: PluggableInventoryItemDefinition[] }
  | { type: 'updateSubclass'; item: DimItem }
  | { type: 'removeSubclass' }
  | { type: 'updateSubclassSocketOverrides'; socketOverrides: { [socketIndex: number]: number } }
  | { type: 'removeSingleSubclassSocketOverride'; plug: PluggableInventoryItemDefinition }
  | { type: 'lockExotic'; lockedExoticHash: number }
  | { type: 'removeLockedExotic' }
  | { type: 'openModPicker'; plugCategoryHashWhitelist?: number[] }
  | { type: 'closeModPicker' }
  | { type: 'openCompareDrawer'; set: ArmorSet }
  | { type: 'closeCompareDrawer' };

// TODO: Move more logic inside the reducer
function lbStateReducer(defs: D2ManifestDefinitions) {
  return (state: LoadoutBuilderState, action: LoadoutBuilderAction): LoadoutBuilderState => {
    switch (action.type) {
      case 'changeCharacter':
        // We don't reset much since we constrain the stores based on what's selected?
        return {
          ...state,
          selectedStoreId: action.storeId,
          pinnedItems: {},
          excludedItems: {},
        };
      case 'statFiltersChanged':
        return { ...state, statFilters: action.statFilters };
      case 'pinItem': {
        const { item } = action;
        const bucketHash = item.bucket.hash;
        return {
          ...state,
          // Remove any previously locked item in that bucket and add this one
          pinnedItems: {
            ...state.pinnedItems,
            [bucketHash]: item,
          },
          // Locking an item clears excluded items in this bucket
          excludedItems: {
            ...state.excludedItems,
            [bucketHash]: undefined,
          },
        };
      }
      case 'setPinnedItems': {
        const { items } = action;
        return {
          ...state,
          pinnedItems: _.keyBy(items, (i) => i.bucket.hash),
          excludedItems: {},
        };
      }
      case 'unpinItem': {
        const { item } = action;
        const bucketHash = item.bucket.hash;
        return {
          ...state,
          pinnedItems: {
            ...state.pinnedItems,
            [bucketHash]: undefined,
          },
        };
      }
      case 'excludeItem': {
        const { item } = action;
        const bucketHash = item.bucket.hash;
        if (state.excludedItems[bucketHash]?.some((i) => i.id === item.id)) {
          return state; // item's already there
        }
        const existingExcluded = state.excludedItems[bucketHash] ?? [];
        return {
          ...state,
          // Also unpin items in this bucket
          pinnedItems: {
            ...state.pinnedItems,
            [bucketHash]: undefined,
          },
          excludedItems: {
            ...state.excludedItems,
            [bucketHash]: [...existingExcluded, item],
          },
        };
      }
      case 'unexcludeItem': {
        const { item } = action;
        const bucketHash = item.bucket.hash;
        const newExcluded = (state.excludedItems[bucketHash] ?? []).filter((i) => i.id !== item.id);
        return {
          ...state,
          excludedItems: {
            ...state.excludedItems,
            [bucketHash]: newExcluded.length > 0 ? newExcluded : undefined,
          },
        };
      }
      case 'lockedModsChanged': {
        return mergeLoadoutParameters(state, {
          mods: action.lockedMods.map((m) => m.hash),
        });
      }
      case 'sortOrderChanged': {
        return {
          ...state,
          statOrder: action.sortOrder,
        };
      }
      case 'assumeArmorMasterworkChanged': {
        const { assumeArmorMasterwork } = action;
        return mergeLoadoutParameters(state, { assumeArmorMasterwork });
      }
      case 'lockArmorEnergyTypeChanged': {
        const { lockArmorEnergyType } = action;
        return mergeLoadoutParameters(state, { lockArmorEnergyType });
      }
      case 'addGeneralMods': {
        const newMods = [...(state.loadout.parameters?.mods ?? [])];
        let currentGeneralModsCount =
          newMods.filter(
            (mod) =>
              defs.InventoryItem.get(mod)?.plug?.plugCategoryHash ===
              armor2PlugCategoryHashesByName.general
          ).length ?? 0;

        const failures: string[] = [];

        for (const mod of action.mods) {
          if (currentGeneralModsCount < 5) {
            newMods.push(mod.hash);
            currentGeneralModsCount++;
          } else {
            failures.push(mod.displayProperties.name);
          }
        }

        if (failures.length) {
          showNotification({
            title: t('LoadoutBuilder.UnableToAddAllMods'),
            body: t('LoadoutBuilder.UnableToAddAllModsBody', { mods: failures.join(', ') }),
            type: 'warning',
          });
        }

        return mergeLoadoutParameters(state, {
          mods: newMods,
        });
      }
      case 'removeLockedMod': {
        const newMods = [...(state.loadout.parameters?.mods ?? [])];
        const indexToRemove = newMods.findIndex((mod) => mod === action.mod.hash);
        if (indexToRemove >= 0) {
          newMods.splice(indexToRemove, 1);
        }

        return mergeLoadoutParameters(state, { mods: newMods });
      }
      case 'updateSubclass': {
        // const { item } = action;

        return {
          ...state,
          // TODO: gotta update the item in the loadout??
          // subclass: { ...item, socketOverrides: createSubclassDefaultSocketOverrides(item) },
        };
      }
      case 'removeSubclass': {
        // TODO: gotta update the item in the loadout??
        return state; // { ...state, subclass: undefined };
      }
      case 'updateSubclassSocketOverrides': {
        // if (!state.subclass) {
        //  return state;
        // }

        // TODO: gotta update the item in the loadout??
        // const { socketOverrides } = action;
        return state; // { ...state, subclass: { ...state.subclass, socketOverrides } };
      }
      case 'removeSingleSubclassSocketOverride': {
        // if (!state.subclass) {
        //  return state;
        // }
        /*
        const { plug } = action;
        const abilityAndSuperSockets = getSocketsByCategoryHashes(state.subclass.sockets, [
          SocketCategoryHashes.Abilities_Abilities_DarkSubclass,
          SocketCategoryHashes.Abilities_Abilities_LightSubclass,
          SocketCategoryHashes.Super,
        ]);
        const newSocketOverrides = { ...state.subclass?.socketOverrides };
        let socketIndexToRemove: number | undefined;

        // Find the socket index to remove the plug from.
        for (const socketIndexString of Object.keys(newSocketOverrides)) {
          const socketIndex = parseInt(socketIndexString, 10);
          const overridePlugHash = newSocketOverrides[socketIndex];
          if (overridePlugHash === plug.hash) {
            socketIndexToRemove = socketIndex;
            break;
          }
        }

        // If we are removing from an ability/super socket, find the socket so we can
        // show the default plug instead
        const abilitySocketRemovingFrom = abilityAndSuperSockets.find(
          (socket) => socket.socketIndex === socketIndexToRemove
        );

        if (socketIndexToRemove !== undefined && abilitySocketRemovingFrom) {
          // If this is an ability socket, replace with the default plug hash
          newSocketOverrides[socketIndexToRemove] =
            abilitySocketRemovingFrom.socketDefinition.singleInitialItemHash;
        } else if (socketIndexToRemove) {
          // If its not an ability we just remove it from the overrides
          delete newSocketOverrides[socketIndexToRemove];
        }
        return {
          ...state,
          subclass: {
            ...state.subclass,
            socketOverrides: Object.keys(newSocketOverrides).length
              ? newSocketOverrides
              : undefined,
          },
        };
        */
        return state;
      }
      case 'lockExotic': {
        const { lockedExoticHash } = action;
        return mergeLoadoutParameters(state, {
          exoticArmorHash: lockedExoticHash,
        });
      }
      case 'removeLockedExotic': {
        return mergeLoadoutParameters(state, {
          exoticArmorHash: undefined,
        });
      }
      case 'openModPicker':
        return {
          ...state,
          modPicker: {
            open: true,
            plugCategoryHashWhitelist: action.plugCategoryHashWhitelist,
          },
        };
      case 'closeModPicker':
        return { ...state, modPicker: { open: false } };
      case 'openCompareDrawer':
        return { ...state, compareSet: action.set };
      case 'closeCompareDrawer':
        return { ...state, compareSet: undefined };
    }
  };
}

function mergeLoadoutParameters(
  state: LoadoutBuilderState,
  params: LoadoutParameters
): LoadoutBuilderState {
  return {
    ...state,
    loadout: {
      ...state.loadout,
      parameters: {
        ...state.loadout.parameters,
        ...params,
      },
    },
  };
}

export function useLbState(args: InitializerArgs) {
  return useReducer(lbStateReducer(args.defs), args, lbStateInit);
}
