import { extendEnvironment } from "hardhat/config";
import {
  ethers,
  AbstractSigner,
  AddressLike,
  Provider,
  Signer,
  TransactionRequest,
  TransactionResponse,
  TypedDataDomain,
  TypedDataEncoder,
  TypedDataField,
  JsonRpcProvider,
} from "ethers";
import { SignTypedDataVersion } from "@metamask/eth-sig-util";
import { GcpKmsSigner, GcpKmsSignerCredentials } from "ethers-gcp-kms-signer";
import { Web3Provider } from "@ethersproject/providers";
import { HttpNetworkConfig, RequestArguments } from "hardhat/types";
import { LocalAccountsProvider } from "hardhat/internal/core/providers/accounts";
import { validateParams } from "hardhat/internal/core/jsonrpc/types/input/validation";
import { rpcTransactionRequest } from "hardhat/internal/core/jsonrpc/types/input/transactionRequest";
import { bytesToHex } from "@nomicfoundation/ethereumjs-util";

class GcpKmsSignerV6 extends AbstractSigner {
  private readonly _signer: GcpKmsSigner;
  constructor(private kmsCredentials: GcpKmsSignerCredentials, provider?: Provider) {
    super(provider);
    this._signer = new GcpKmsSigner(kmsCredentials);
  }
  async getAddress(): Promise<string> {
    return await this._signer.getAddress();
  }
  connect(provider: Provider | null): ethers.Signer {
    return new GcpKmsSignerV6(this.kmsCredentials, provider || undefined);
  }
  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    return await this._signer.signTransaction({
      ...tx,
      to: await resolveAddress(tx.to),
      from: await resolveAddress(tx.from),
      nonce: tx.nonce?.toString(),
      gasLimit: tx.gasLimit?.toString(),
      gasPrice: tx.gasPrice?.toString(),
      maxFeePerGas: tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
      value: tx.value?.toString(),
      data: tx.data || undefined,
      chainId: parseInt((tx.chainId || "")?.toString(), 10) || undefined,
      type: tx.type || undefined,
      accessList: tx.accessList || undefined,
    });
  }
  async signMessage(message: string | Uint8Array): Promise<string> {
    return await this._signer.signMessage(message);
  }
  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (value: string) => {
      const address = await resolveAddress(value);
      if (!address) {
        throw new Error("Address is null");
      }
      return address;
    });
    return await this._signer.signTypedData({
      version: SignTypedDataVersion.V4,
      data: TypedDataEncoder.getPayload(populated.domain, types, populated.value),
    });
  }
}

async function resolveAddress(addr: AddressLike | null | undefined): Promise<string | undefined> {
  return addr && typeof addr === "object" && "getAddress" in addr ? await addr.getAddress() : addr || undefined;
}

export function getEthSignerWithKeyPath(keyPath: string) {
  const [, projectId, locationId, keyRingId, keyId, keyVersion] =
    /^\s*projects\/([^/]+?)\/locations\/([^/]+?)\/keyRings\/([^/]+?)\/cryptoKeys\/([^/]+?)\/cryptoKeyVersions\/([^/]+?)\s*$/.exec(
      keyPath
    ) as string[];
  const signer = new GcpKmsSignerV6({ projectId, locationId, keyRingId, keyId, keyVersion });
  return signer;
}

let registeredSigners = {} as { [address: string]: GcpKmsSignerV6 };

export function registerSigner(address: string, keyPath: string) {
  address = ethers.getAddress(address);
  registeredSigners[address] = getEthSignerWithKeyPath(keyPath);
}

const getSignerApply: (rpcUrl?: string) => ProxyHandler<any>["apply"] = (rpcUrl) => (target, thisArg, args) => {
  const signer = registeredSigners[ethers.getAddress(args[0])];
  if (signer) {
    return signer.connect(rpcUrl ? new JsonRpcProvider(rpcUrl) : thisArg?.provider);
  }
  return Reflect.apply(target, thisArg, args);
};
const sendApply: ProxyHandler<any>["apply"] = function (target, thisArg, args) {
  const promise = Reflect.apply(target, thisArg, args);
  if (args[0] !== "eth_accounts") {
    return promise;
  }
  return Promise.resolve(promise)
    .then((accounts) =>
      (accounts as string[]).concat(
        Object.keys(registeredSigners).filter((x) => !(accounts as string[]).includes(ethers.getAddress(x)))
      )
    )
    .catch(() => Object.keys(registeredSigners));
};
function patchField<T, N extends keyof T>(obj: T, prop: N, transformValue: (value: T[N], obj: T) => any): T {
  let value = obj[prop];
  if (!value) {
    console.warn(`${prop.toString()} is falsy`);
  }
  const enumerable = value ? Object.getOwnPropertyDescriptor(obj, prop)?.enumerable ?? false : false;
  let transformedValue = value ? transformValue(value, obj) : value;
  delete obj[prop];
  Object.defineProperty(obj, prop, {
    get() {
      return transformedValue;
    },
    set(newValue) {
      if (newValue === value) {
        return;
      }
      value = newValue;
      transformedValue = value ? transformValue(value, obj) : value;
    },
    configurable: false,
    enumerable,
  });
  return obj;
}

class SignerWithAddressAlt extends AbstractSigner<Provider> {
  public static async create(signer: Signer) {
    return new SignerWithAddressAlt(await signer.getAddress(), signer);
  }

  private constructor(public readonly address: string, private readonly _signer: ethers.Signer) {
    super(_signer.provider || undefined);
  }

  public async getAddress(): Promise<string> {
    return this.address;
  }

  public signMessage(message: string | Uint8Array): Promise<string> {
    return this._signer.signMessage(message);
  }

  signTransaction(tx: TransactionRequest): Promise<string> {
    return this._signer.signTransaction(tx);
  }

  public sendTransaction(transaction: TransactionRequest): Promise<TransactionResponse> {
    return this._signer.sendTransaction(transaction);
  }

  public connect(provider: Provider): SignerWithAddressAlt {
    return new SignerWithAddressAlt(this.address, this._signer.connect(provider));
  }

  public signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, any>
  ): Promise<string> {
    return this._signer.signTypedData(domain, types, value);
  }

  public toJSON() {
    return `<SignerWithAddressAlt ${this.address}>`;
  }
}

extendEnvironment((env) => {
  const networkConfig = env.network as unknown as HttpNetworkConfig;
  patchField(env, "ethers", (ethers) => {
    patchField(
      ethers,
      "getSigner",
      (oldFunc) =>
        new Proxy(oldFunc, {
          apply: async function (...args) {
            let signer: Signer = await getSignerApply(networkConfig.url)!(...args);
            if (!signer.provider && env.ethers.provider) {
              signer = signer.connect(env.ethers.provider);
            }
            return await SignerWithAddressAlt.create(signer);
          },
        })
    );
    patchField(
      ethers,
      "getSigners",
      (oldFunc) =>
        new Proxy(oldFunc, {
          apply: function (target, thisArg, args) {
            const promise = Reflect.apply(target, thisArg, args);
            return Promise.resolve(promise).then(async (signers: SignerWithAddressAlt[]) =>
              signers
                .filter((x) => !registeredSigners[env.ethers.getAddress(x.address)])
                .concat(
                  await Promise.all(
                    Object.values(registeredSigners).map((x) =>
                      SignerWithAddressAlt.create(signers[0].provider ? (x.connect(signers[0].provider) as any) : x)
                    )
                  )
                )
            );
          },
        })
    );
    return ethers;
  });
  let proto = ethers.JsonRpcProvider.prototype;
  proto.getSigner = new Proxy(proto.getSigner, {
    apply: getSignerApply(networkConfig.url),
  });
  proto.listAccounts = new Proxy(proto.listAccounts, {
    apply: function (target, thisArg, args) {
      const promise = Reflect.apply(target, thisArg, args);
      return Promise.resolve(promise)
        .then((accounts) =>
          accounts.concat(Object.keys(registeredSigners).filter((x) => !accounts.includes(ethers.getAddress(x))))
        )
        .catch(() => Object.keys(registeredSigners));
    },
  });
  proto.send = new Proxy(proto.send, {
    apply: sendApply,
  });
  Web3Provider.prototype.send = new Proxy(Web3Provider.prototype.send, {
    apply: sendApply,
  });
  LocalAccountsProvider.prototype.request = new Proxy(LocalAccountsProvider.prototype.request, {
    apply: async function (target, thisArg, argsArray) {
      const args: RequestArguments = argsArray[0];

      if (args.method === "eth_sendTransaction") {
        const params: any[] = thisArg._getParams(args);
        const [txRequest] = validateParams(params, rpcTransactionRequest);

        const from = ethers.getAddress(bytesToHex(txRequest.from));
        const signer = registeredSigners[from];
        if (signer) {
          if (txRequest.nonce === undefined) {
            txRequest.nonce = await thisArg._getNonce(txRequest.from);
          }
          if (txRequest.accessList) {
            throw new Error("Not implemented");
          }
          const rawTransaction = await signer.signTransaction({
            type: txRequest.maxFeePerGas ? 2 : undefined,
            from,
            to: txRequest.to ? bytesToHex(txRequest.to) : undefined,
            nonce: Number(txRequest.nonce),
            gasLimit: txRequest.gas,
            gasPrice: txRequest.gasPrice,
            maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas,
            maxFeePerGas: txRequest.maxFeePerGas,
            data: txRequest.data ? bytesToHex(txRequest.data) : undefined,
            value: txRequest.value,
            chainId: txRequest.chainId || (await env.getChainId()),
          });
          argsArray[0] = {
            method: "eth_sendRawTransaction",
            params: [rawTransaction],
          };
        }
      }
      return Reflect.apply(target, thisArg, argsArray);
    },
  });
});
