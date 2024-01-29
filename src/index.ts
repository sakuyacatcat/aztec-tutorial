import { getSchnorrAccount } from '@aztec/accounts/schnorr';
import { getDeployedTestAccountsWallets } from '@aztec/accounts/testing';
import {
  ExtendedNote,
  Fr,
  GrumpkinScalar,
  Note,
  PXE,
  computeMessageSecretHash,
  createDebugLogger,
  createPXEClient,
  waitForPXE,
} from '@aztec/aztec.js';
import { TokenContract } from '@aztec/noir-contracts/Token';
// import { CounterContract } from "../contracts/counter/src/artifacts/Counter";


import { format } from 'util';

const { PXE_URL = 'http://localhost:8080' } = process.env;

async function main() {
  ////////////// CREATE THE CLIENT INTERFACE AND CONTACT THE SANDBOX //////////////
  const logger = createDebugLogger("token");

  // We create PXE client connected to the sandbox URL
  const pxe = createPXEClient(PXE_URL);
  // Wait for sandbox to be ready
  await waitForPXE(pxe, logger);

  const nodeInfo = await pxe.getNodeInfo();

  logger(format("Aztec Sandbox Info ", nodeInfo));

  ////////////// LOAD SOME ACCOUNTS FROM THE SANDBOX //////////////
  // The sandbox comes with a set of created accounts. Load them
  const accounts = await getDeployedTestAccountsWallets(pxe);
  const aliceWallet = accounts[0];
  const bobWallet = accounts[1];
  const alice = aliceWallet.getAddress();
  const bob = bobWallet.getAddress();
  logger(`Loaded alice's account at ${alice.toShortString()}`);
  logger(`Loaded bob's account at ${bob.toShortString()}`);

  ////////////// DEPLOY OUR TOKEN CONTRACT //////////////

  const initialSupply = 1_000_000n;
  logger(`Deploying token contract...`);

  // Deploy the contract and set Alice as the admin while doing so
  const contract = await TokenContract.deploy(
    aliceWallet,
    alice,
    "TokenName",
    "TokenSymbol",
    18
  )
    .send()
    .deployed();
  logger(
    `Contract successfully deployed at address ${contract.address.toShortString()}`
  );

  // Create the contract abstraction and link it to Alice's wallet for future signing
  const tokenContractAlice = await TokenContract.at(
    contract.address,
    aliceWallet
  );

  // Create a secret and a corresponding hash that will be used to mint funds privately
  const aliceSecret = Fr.random();
  const aliceSecretHash = computeMessageSecretHash(aliceSecret);

  logger(`Minting tokens to Alice...`);
  // Mint the initial supply privately "to secret hash"
  const receipt = await tokenContractAlice.methods
    .mint_private(initialSupply, aliceSecretHash)
    .send()
    .wait();

  // Add the newly created "pending shield" note to PXE
  const pendingShieldsStorageSlot = new Fr(5); // The storage slot of `pending_shields` is 5.
  const note = new Note([new Fr(initialSupply), aliceSecretHash]);
  await pxe.addNote(
    new ExtendedNote(
      note,
      alice,
      contract.address,
      pendingShieldsStorageSlot,
      receipt.txHash
    )
  );

  // Make the tokens spendable by redeeming them using the secret (converts the "pending shield note" created above
  // to a "token note")
  await tokenContractAlice.methods
    .redeem_shield(alice, initialSupply, aliceSecret)
    .send()
    .wait();
  logger(
    `${initialSupply} tokens were successfully minted and redeemed by Alice`
  );

  ////////////// QUERYING THE TOKEN BALANCE FOR EACH ACCOUNT //////////////

  // Bob wants to mint some funds, the contract is already deployed, create an abstraction and link it his wallet
  // Since we already have a token link, we can simply create a new instance of the contract linked to Bob's wallet
  const tokenContractBob = tokenContractAlice.withWallet(bobWallet);

  let aliceBalance = await tokenContractAlice.methods
    .balance_of_private(alice)
    .view();
  logger(`Alice's balance ${aliceBalance}`);

  let bobBalance = await tokenContractBob.methods
    .balance_of_private(bob)
    .view();
  logger(`Bob's balance ${bobBalance}`);

  ////////////// TRANSFER FUNDS FROM ALICE TO BOB //////////////

  // We will now transfer tokens from ALice to Bob
  const transferQuantity = 543n;
  logger(`Transferring ${transferQuantity} tokens from Alice to Bob...`);
  await tokenContractAlice.methods
    .transfer(alice, bob, transferQuantity, 0)
    .send()
    .wait();

  // Check the new balances
  aliceBalance = await tokenContractAlice.methods
    .balance_of_private(alice)
    .view();
  logger(`Alice's balance ${aliceBalance}`);

  bobBalance = await tokenContractBob.methods.balance_of_private(bob).view();
  logger(`Bob's balance ${bobBalance}`);

  ////////////// MINT SOME MORE TOKENS TO BOB'S ACCOUNT //////////////

  // Now mint some further funds for Bob

  // Alice is nice and she adds Bob as a minter
  await tokenContractAlice.methods.set_minter(bob, true).send().wait();

  const bobSecret = Fr.random();
  const bobSecretHash = computeMessageSecretHash(bobSecret);
  // Bob now has a secret 🥷

  const mintQuantity = 10_000n;
  logger(`Minting ${mintQuantity} tokens to Bob...`);
  const mintPrivateReceipt = await tokenContractBob.methods
    .mint_private(mintQuantity, bobSecretHash)
    .send()
    .wait();

  const bobPendingShield = new Note([new Fr(mintQuantity), bobSecretHash]);
  await pxe.addNote(
    new ExtendedNote(
      bobPendingShield,
      bob,
      contract.address,
      pendingShieldsStorageSlot,
      mintPrivateReceipt.txHash
    )
  );

  await tokenContractBob.methods
    .redeem_shield(bob, mintQuantity, bobSecret)
    .send()
    .wait();

  // Check the new balances
  aliceBalance = await tokenContractAlice.methods
    .balance_of_private(alice)
    .view();
  logger(`Alice's balance ${aliceBalance}`);

  bobBalance = await tokenContractBob.methods.balance_of_private(bob).view();
  logger(`Bob's balance ${bobBalance}`);
}

main();