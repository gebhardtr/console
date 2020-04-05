import * as _ from 'lodash';
import {
  ImportProvidersField,
  VM_WIZARD_DIFFICULT_TABS,
  VMImportProvider,
  VMSettingsField,
  VMWareProviderField,
  VMWareProviderProps,
  VMWizardProps,
} from '../../../../../types';
import { InternalActionType, UpdateOptions } from '../../../../types';
import {
  iGetCommonData,
  iGetLoadedCommonData,
  iGetName,
} from '../../../../../selectors/immutable/selectors';
import {
  hasVMWareSettingsChanged,
  hasVMWareSettingsValueChanged,
  iGetVMWareField,
  iGetVMWareFieldAttribute,
  iGetVMWareFieldValue,
  isVMWareProvider,
} from '../../../../../selectors/immutable/provider/vmware/selectors';
import { vmWizardInternalActions } from '../../../../internal-actions';
import { asDisabled, asHidden, asRequired } from '../../../../../utils/utils';
import { getSimplePodDeploymentStatus } from '../../../../../../../statuses/pod-deployment/pod-deployment-status';
import { PodDeploymentStatus } from '../../../../../../../statuses/pod-deployment/constants';
import {
  iGet,
  iGetIn,
  immutableListToShallowJS,
  toShallowJS,
} from '../../../../../../../utils/immutable';
import {
  getSimpleV2VPRoviderStatus,
  V2V_PROVIDER_STATUS_ALL_OK,
  V2VProviderStatus,
} from '../../../../../../../statuses/v2v';
import { getThumbprint, getLoadedVm } from '../../../../../selectors/provider/vmware/selectors';
import { getSimpleName } from '../../../../../../../selectors/utils';
import { correctVMImportProviderSecretLabels } from '../../../../../../../k8s/requests/v2v/correct-vm-import-provider-secret-labels';
import {
  createConnectionObjects,
  startV2VVMWareControllerWithCleanup,
} from './vmware-provider-actions';
import { prefillUpdateCreator } from './vmware-prefill-vm';
import { hasImportProvidersChanged } from '../../../../../selectors/immutable/import-providers';
import { updateExtraWSQueries } from './update-ws-queries';
import { iGetCreateVMWizardTabs } from '../../../../../selectors/immutable/common';
import { cleanupVmWareProvider } from './vmware-cleanup';

const startControllerAndCleanup = (options: UpdateOptions) => {
  const { id, prevState, getState } = options;
  const state = getState();
  if (!hasImportProvidersChanged(prevState, state, id, ImportProvidersField.PROVIDER)) {
    return;
  }

  const namespace = iGetCommonData(state, id, VMWizardProps.activeNamespace);

  cleanupVmWareProvider(options); // call should be idempotent and called on every provider change

  if (isVMWareProvider(state, id) && namespace) {
    startV2VVMWareControllerWithCleanup(options); // fire side effect
  }
};

const deploymentChanged = (options: UpdateOptions) => {
  const { id, getState, changedCommonData, dispatch } = options;
  const state = getState();

  if (
    !changedCommonData.has(VMWareProviderProps.deployment) &&
    !changedCommonData.has(VMWareProviderProps.deploymentPods)
  ) {
    return;
  }

  const iDeployment = iGet(iGetCommonData(state, id, VMWareProviderProps.deployment), 'data');
  const deployment = toShallowJS(iDeployment, undefined, true);
  const deploymentPods = immutableListToShallowJS(
    iGetLoadedCommonData(state, id, VMWareProviderProps.deploymentPods),
  );

  const status = getSimplePodDeploymentStatus(deployment, deploymentPods);

  const isLastErrorHidden = !!deployment;
  const isVCenterDisabled = status !== PodDeploymentStatus.ROLLOUT_COMPLETE;

  if (
    iGet(
      iGetVMWareFieldAttribute(state, id, VMWareProviderField.V2V_LAST_ERROR, 'isHidden'),
      VMImportProvider.VMWARE,
    ) !== isLastErrorHidden ||
    iGet(
      iGetVMWareFieldAttribute(state, id, VMWareProviderField.VCENTER, 'isDisabled'),
      VMImportProvider.VMWARE,
    ) !== isVCenterDisabled
  ) {
    dispatch(
      vmWizardInternalActions[InternalActionType.UpdateImportProvider](
        id,
        VMImportProvider.VMWARE,
        {
          [VMWareProviderField.V2V_LAST_ERROR]: {
            isHidden: asHidden(isLastErrorHidden, VMImportProvider.VMWARE),
          },
          [VMWareProviderField.VCENTER]: {
            isDisabled: asDisabled(isVCenterDisabled, VMImportProvider.VMWARE),
          },
        },
      ),
    );
  }
};

const v2vVmWareUpdater = (options: UpdateOptions) => {
  const { id, prevState, changedCommonData, dispatch, getState } = options;
  const state = getState();

  if (!changedCommonData.has(VMWareProviderProps.v2vvmware)) {
    return;
  }

  const iV2vvmware = iGet(iGetCommonData(state, id, VMWareProviderProps.v2vvmware), 'data');
  const v2vvmware = toShallowJS(iV2vvmware, undefined, true);

  const selectedVmName = iGetVMWareFieldValue(state, id, VMWareProviderField.VM);
  const vm = getLoadedVm(v2vvmware, selectedVmName);

  const vmWareStatus = getSimpleV2VPRoviderStatus(v2vvmware, { requestsVM: selectedVmName && !vm }); // hack around unresponsiveness of v2vvmware

  dispatch(
    vmWizardInternalActions[InternalActionType.UpdateImportProvider](id, VMImportProvider.VMWARE, {
      [VMWareProviderField.VM]: {
        isDisabled: asDisabled(
          _.isEmpty(iV2vvmware) || iV2vvmware.isEmpty(),
          VMWareProviderField.VM,
        ),
        // data for request
        vm: selectedVmName && !vm ? undefined : vm, // moving across tabs resets listening for v2vvmware
        thumbprint: getThumbprint(v2vvmware),
      },
      [VMWareProviderField.STATUS]: {
        value: vmWareStatus?.getValue(),
      },
    }),
  );

  if (vmWareStatus === V2VProviderStatus.CONNECTION_SUCCESSFUL) {
    const activeVcenterSecret = iGetLoadedCommonData(
      state,
      id,
      VMWareProviderProps.activeVcenterSecret,
    );
    correctVMImportProviderSecretLabels({
      provider: VMImportProvider.VMWARE,
      secret: toShallowJS(activeVcenterSecret, undefined, true),
      saveCredentialsRequested: iGetVMWareFieldValue(
        state,
        id,
        VMWareProviderField.REMEMBER_PASSWORD,
      ),
    });
  }

  const prevVm = iGetVMWareFieldAttribute(prevState, id, VMWareProviderField.VM, 'vm');
  const prevLoadedVmName = prevVm && prevVm.get('name');
  const loadedVmName = getSimpleName(vm);

  if (!vm || prevLoadedVmName === loadedVmName || loadedVmName !== selectedVmName) {
    return;
  }

  prefillUpdateCreator(options);
};

const vmChangedUpdater = (options: UpdateOptions) => {
  const { id, prevState, dispatch, getState } = options;
  const state = getState();
  if (!hasVMWareSettingsValueChanged(prevState, state, id, VMWareProviderField.VM)) {
    return;
  }

  if (iGetCommonData(state, id, VMWizardProps.isSimpleView)) {
    VM_WIZARD_DIFFICULT_TABS.forEach((tab) => {
      if (!iGetIn(iGetCreateVMWizardTabs(state, id), [tab, 'isHidden'])) {
        dispatch(vmWizardInternalActions[InternalActionType.SetTabHidden](id, tab, true));
      }
    });
  }
};

const providerUpdater = (options: UpdateOptions) => {
  const { id, prevState, dispatch, getState } = options;
  const state = getState();
  if (
    !(
      hasImportProvidersChanged(prevState, state, id, ImportProvidersField.PROVIDER) ||
      hasVMWareSettingsChanged(
        prevState,
        state,
        id,
        VMWareProviderField.STATUS,
        VMWareProviderField.VM,
      )
    )
  ) {
    return;
  }

  const namespace = iGetCommonData(state, id, VMWizardProps.activeNamespace);
  const loadedVm = iGetVMWareFieldAttribute(state, id, VMWareProviderField.VM, 'vm');
  const iStatus = iGetVMWareFieldValue(state, id, VMWareProviderField.STATUS);
  const status = V2VProviderStatus.fromString(iStatus);

  const hasLoadedVm = !!loadedVm;
  const isVmWareProvider = isVMWareProvider(state, id);
  const isOkStatus = V2V_PROVIDER_STATUS_ALL_OK.has(status);

  const hiddenMetadata = {
    isHidden: asHidden(!namespace || !isVmWareProvider, VMImportProvider.VMWARE),
  };

  const requiredMetadata = {
    ...hiddenMetadata,
    isRequired: asRequired(isVmWareProvider, VMImportProvider.VMWARE),
  };

  const isEditingDisabled = isVmWareProvider && !(hasLoadedVm && isOkStatus);
  const needsValuesReset = !isVmWareProvider || (isVmWareProvider && !hasLoadedVm);

  const vmFieldUpdate = {
    isDisabled: asDisabled(isEditingDisabled, VMImportProvider.VMWARE),
    value: needsValuesReset ? null : undefined,
  };

  dispatch(
    vmWizardInternalActions[InternalActionType.UpdateVmSettings](id, {
      [VMSettingsField.NAME]: vmFieldUpdate,
      [VMSettingsField.DESCRIPTION]: vmFieldUpdate,
      [VMSettingsField.OPERATING_SYSTEM]: vmFieldUpdate,
      [VMSettingsField.FLAVOR]: vmFieldUpdate,
      [VMSettingsField.MEMORY]: vmFieldUpdate,
      [VMSettingsField.CPU]: vmFieldUpdate,
      [VMSettingsField.WORKLOAD_PROFILE]: vmFieldUpdate,
    }),
  );

  dispatch(
    vmWizardInternalActions[InternalActionType.UpdateImportProvider](id, VMImportProvider.VMWARE, {
      [VMWareProviderField.VCENTER]: requiredMetadata,
      [VMWareProviderField.HOSTNAME]: hiddenMetadata,
      [VMWareProviderField.USER_NAME]: hiddenMetadata,
      [VMWareProviderField.USER_PASSWORD_AND_CHECK_CONNECTION]: hiddenMetadata,
      [VMWareProviderField.REMEMBER_PASSWORD]: hiddenMetadata,
      [VMWareProviderField.V2V_LAST_ERROR]: hiddenMetadata,
      [VMWareProviderField.VM]: {
        ...requiredMetadata,
        isDisabled: asDisabled(
          !isOkStatus && status !== V2VProviderStatus.LOADING_VM_DETAIL_FAILED,
          VMImportProvider.VMWARE,
        ),
        value: !isVmWareProvider ? null : undefined,
        vm: !isVmWareProvider ? null : undefined,
        thumbprint: !isVmWareProvider ? null : undefined,
      },
      [VMWareProviderField.STATUS]: {
        isHidden: asHidden(
          !isVmWareProvider ||
            V2V_PROVIDER_STATUS_ALL_OK.has(status) ||
            status === V2VProviderStatus.UNKNOWN,
          VMImportProvider.VMWARE,
        ),
      },
    }),
  );
};

const secretUpdater = (options) => {
  const { id, prevState, dispatch, getState } = options;
  const state = getState();
  if (!hasVMWareSettingsValueChanged(prevState, state, id, VMWareProviderField.VCENTER)) {
    return;
  }

  const connectionSecretName = iGetName(
    iGetVMWareFieldAttribute(state, id, VMWareProviderField.VCENTER, 'secret'),
  );
  const isNewInstanceSecret = iGetVMWareFieldAttribute(
    state,
    id,
    VMWareProviderField.VCENTER,
    'isNewInstance',
  );

  const hiddenMetadata = {
    isHidden: asHidden(!isNewInstanceSecret, VMWareProviderField.VCENTER),
  };

  const metadata = {
    ...hiddenMetadata,
    isRequired: asRequired(isNewInstanceSecret, VMWareProviderField.VCENTER),
  };

  dispatch(
    vmWizardInternalActions[InternalActionType.UpdateImportProvider](id, VMImportProvider.VMWARE, {
      [VMWareProviderField.HOSTNAME]: metadata,
      [VMWareProviderField.USER_NAME]: metadata,
      [VMWareProviderField.USER_PASSWORD_AND_CHECK_CONNECTION]: metadata,
      [VMWareProviderField.REMEMBER_PASSWORD]: hiddenMetadata,
    }),
  );

  if (!isNewInstanceSecret && connectionSecretName) {
    // side effect
    createConnectionObjects(options, {
      namespace: iGetCommonData(state, id, VMWizardProps.activeNamespace),
      connectionSecretName,
      prevNamespace: iGetCommonData(prevState, id, VMWizardProps.activeNamespace),
      prevV2VName: iGetVMWareField(prevState, id, VMWareProviderField.V2V_NAME),
    });
  }
};

export const getVMWareProviderStateUpdater = (options: UpdateOptions) =>
  [
    updateExtraWSQueries,
    startControllerAndCleanup,
    deploymentChanged,
    v2vVmWareUpdater,
    vmChangedUpdater,
    providerUpdater,
    secretUpdater,
  ].forEach((updater) => {
    updater && updater(options);
  });
