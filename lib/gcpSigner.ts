import { extendEnvironment } from "hardhat/config";
import { ethers } from "ethers";
import { GcpKmsSigner } from "ethers-gcp-kms-signer";

export function getEthSignerWithKeyPath(keyPath: string) {
  const [, projectId, locationId, keyRingId, keyId, keyVersion] =
    /^\s*projects\/([^/]+?)\/locations\/([^/]+?)\/keyRings\/([^/]+?)\/cryptoKeys\/([^/]+?)\/cryptoKeyVersions\/([^/]+?)\s*$/.exec(
      keyPath
    ) as string[];
  const signer = new GcpKmsSigner({ projectId, locationId, keyRingId, keyId, keyVersion });
  return signer;
}

let registeredSigners = {} as { [address: string]: GcpKmsSigner };

export function registerSigner(address: string, keyPath: string) {
  address = ethers.utils.getAddress(address);
  registeredSigners[address] = getEthSignerWithKeyPath(keyPath);
}

const getSignerApply: ProxyHandler<any>["apply"] = function (target, thisArg, args) {
  const signer = registeredSigners[ethers.utils.getAddress(args[0])];
  if (signer) {
    return ethers.providers.Provider.isProvider(thisArg) ? signer.connect(thisArg) : signer;
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
      accounts.concat(Object.keys(registeredSigners).filter((x) => !accounts.includes(ethers.utils.getAddress(x))))
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

class SignerWithAddressAlt extends ethers.Signer {
  public static async create(signer: ethers.Signer) {
    return new SignerWithAddressAlt(await signer.getAddress(), signer);
  }

  private constructor(public readonly address: string, private readonly _signer: ethers.Signer) {
    super();
    (this as any).provider = _signer.provider;
  }

  public async getAddress(): Promise<string> {
    return this.address;
  }

  public signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    return this._signer.signMessage(message);
  }

  public signTransaction(transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>): Promise<string> {
    return this._signer.signTransaction(transaction);
  }

  public sendTransaction(
    transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>
  ): Promise<ethers.providers.TransactionResponse> {
    return this._signer.sendTransaction(transaction);
  }

  public connect(provider: ethers.providers.Provider): SignerWithAddressAlt {
    return new SignerWithAddressAlt(this.address, this._signer.connect(provider));
  }

  public _signTypedData(...params: Parameters<ethers.providers.JsonRpcSigner["_signTypedData"]>): Promise<string> {
    return (this._signer as any)._signTypedData(...params);
  }

  public toJSON() {
    return `<SignerWithAddressAlt ${this.address}>`;
  }
}

extendEnvironment((env) => {
  patchField(env, "ethers", (ethers) => {
    patchField(
      ethers,
      "getSigner",
      (oldFunc) =>
        new Proxy(oldFunc, {
          apply: async function (...args) {
            let signer = await getSignerApply(...args);
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
                .filter((x) => !registeredSigners[env.ethers.utils.getAddress(x.address)])
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
  let proto = ethers.providers.JsonRpcProvider.prototype;
  proto.getSigner = new Proxy(proto.getSigner, {
    apply: getSignerApply,
  });
  proto.listAccounts = new Proxy(proto.listAccounts, {
    apply: function (target, thisArg, args) {
      const promise = Reflect.apply(target, thisArg, args);
      return Promise.resolve(promise)
        .then((accounts) =>
          accounts.concat(Object.keys(registeredSigners).filter((x) => !accounts.includes(ethers.utils.getAddress(x))))
        )
        .catch(() => Object.keys(registeredSigners));
    },
  });
  proto.send = new Proxy(proto.send, {
    apply: sendApply,
  });
  proto = ethers.providers.Web3Provider.prototype;
  proto.send = new Proxy(proto.send, {
    apply: sendApply,
  });
});
