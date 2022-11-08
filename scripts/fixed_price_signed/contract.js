
const { Zilliqa } = require('@zilliqa-js/zilliqa');
const { toChecksumAddress, getAddressFromPrivateKey } = require('@zilliqa-js/crypto');
const { bytes } = require('@zilliqa-js/util');
const { units } = require('@zilliqa-js/util');
const { BN, Long } = require('@zilliqa-js/util');
var EC = require('elliptic').ec;
const { SHA256, enc } = require('crypto-js')


//for testnet
// const zilliqa = new Zilliqa('https://dev-api.zilliqa.com');
// const CHAIN_ID = 333;  //Testnet


//for isolated server
const zilliqa = new Zilliqa('http://localhost:5555');
const CHAIN_ID = 222;  //local


const MSG_VERSION = 1;
const VERSION = bytes.pack(CHAIN_ID, MSG_VERSION);


function PrintTx(signedTx) 
{
    console.log('version: ' + signedTx.version.toString())
    console.log('nonce: ' + signedTx.nonce.toString())
    console.log('toAddr: ' + signedTx.toAddr.toString())
    console.log('amount: ' + signedTx.amount.toString())
    console.log('pubKey: ' + signedTx.pubKey.toString())
    console.log('gasPrice: ' +signedTx.gasPrice.toString())
    console.log('gasLimit: ' +signedTx.gasLimit.toString())
    console.log('code: ' +signedTx.code.toString())
    console.log('data: ' +signedTx.data.toString())
    console.log('signature: ' + signedTx.signature.toString())
}

function Trim(s) 
{
    return s.startsWith('0x') ? s.substring(2) : s;
}

function ToHexArray(num, size)
{
    return bytes.intToHexArray(parseInt(num), size);
}

async function SendTransaction(transition, param, privkey, contract, amount)
{
    const data = {
        _tag: transition,
        params: param,
    };

    // console.log(JSON.stringify(data, null, 4))
    // console.log("To addr " + toChecksumAddress(contract))

    const tx = zilliqa.transactions.new(
        {
            data: JSON.stringify(data),
            version: VERSION,
            toAddr: toChecksumAddress(contract),
            amount: new BN(amount),
            gasPrice: units.toQa('2000', units.Units.Li),
            gasLimit: Long.fromNumber(1000000),
        },
        false,
    );

    zilliqa.wallet.addByPrivateKey(privkey);
    const signedTx = await zilliqa.wallet.sign(tx);

    // console.log("Signed tx")
    // console.log(JSON.stringify(signedTx, null, 4))
    // PrintTx(signedTx)

    console.log("Sending")
    try {
        const res = await zilliqa.blockchain.createTransactionWithoutConfirm(signedTx);
        console.log(JSON.stringify(res, null, 4));
    }
    catch (e) {
        console.error(e);
    }  

}



async function BatchMint(privkey, contract, recipient, uri, start, count) 
{
    
    console.log('BatchMint')

    let tokens = []
    for (let i=start; i<(start+count); i++) {
      tokens.push(
        {
          "argtypes": ["ByStr20", "String"],
          "constructor": "Pair", 
          "arguments": [
            recipient, 
            uri + i 
          ]
        }      
      )
    }

    const param = [
        {
            "vname": "to_token_uri_pair_list",
            "type": `List (Pair (ByStr20) (String))`,
            "value": tokens
        }
    ]

    SendTransaction('BatchMint', param, privkey, contract, 0)
}


async function Mint(privkey, contract, recipient, uri) 
{
    
    console.log('Mint')

    const param = [
        {
            "vname":"to",
            "type":"ByStr20",
            "value": recipient
        },
        {
            "vname":"token_uri",
            "type":"String",
            "value": uri
        }
    ]

    SendTransaction('Mint', param, privkey, contract, 0)

}


async function SetSpender(privkey, contract, tokenId, spender) 
{
  
    const param = [
        {
            "vname":"spender",
            "type":"ByStr20",
            "value": spender
        },
        {
            "vname":"token_id",
            "type":"Uint256",
            "value": tokenId
        }
    ]

    SendTransaction('SetSpender', param, privkey, contract, 0)

}

async function SetOrder(privkey, contract, tokenAddr, 
                        tokenId, salePriceQa, side, expiryInBNum, amount) 
{

    console.log('SetOrder')

    const param = [
        {
            "vname": "order",
            "type": `${contract}.OrderParam`,
            "value": {
                "constructor": `${contract}.OrderParam`,
                "argtypes": [],
                "arguments": [
                    tokenAddr,
                    tokenId,
                    '0x0000000000000000000000000000000000000000',
                    salePriceQa,
                    side,
                    expiryInBNum
                ]    
            }
        }
    ]

    SendTransaction('SetOrder', param, privkey, contract, amount)
}

async function getCurrentBlockNumber() 
{
    const response = await zilliqa.blockchain.getNumTxBlocks();
    const bNum = parseInt(response.result, 10);
    return bNum;
}

async function SerializeMessage(tokenAddr, tokenId, dest, side, price, payment_token_addr, bnum)
{
    // Concat data to serialize
    msg = [Trim(tokenAddr)]                      
            .concat(ToHexArray(tokenId, 64))    // 256 bits->32 bytes->64 chars as hex
            .concat([Trim(dest)])                
            .concat(ToHexArray(side, 8))        // 32 bits->4 bytes->8 chars as hex
            .concat(ToHexArray(price, 32))      // 128 bits->16 bytes->32 chars as hex
            .concat([Trim(payment_token_addr)])  
            .concat(ToHexArray(bnum, 32))       // 128 bits->16 bytes->32 chars as hex
            .join('');

    msg = '0x' + msg
    console.log('serialized msg ' + msg)
    return msg
}


async function SignMessage(privkey, msg)
{
    var ec = new EC('secp256k1');
    const keyPair = ec.keyFromPrivate(Trim(privkey));

    //create a digest from the message
    digest = SHA256(enc.Hex.parse(Trim(msg)))

    //signature must be in canonical form
    sigder = keyPair.sign(digest.toString(), 'hex', {canonical: true})

    // Verify signature
    // console.log(keyPair.verify(digest.toString(), signature));

    //flatten the signature
    const sigrs = Buffer.concat([
        sigder.r.toArrayLike(Buffer, 'be', 32),
        sigder.s.toArrayLike(Buffer, 'be', 32),
    ]);

    signature = "0x" + sigrs.toString('hex')
    console.log('signature ' + signature)

    return signature

}



async function FulfillOrder(signer, privkey, contract, tokenAddr, 
                            tokenId, price, side, dest) 
{
    const payment_token_addr = "0x0000000000000000000000000000000000000000"
    
    //use this for local isolated server
    const bnum = 1 
 
    //otherwise use this
    // const bnum = await(getCurrentBlockNumber())
 
    const msg = await(SerializeMessage(
                            tokenAddr, 
                            tokenId, 
                            dest, 
                            side, 
                            price, 
                            payment_token_addr, 
                            bnum)
                    )
    const signature = await(SignMessage(signer, msg))
    
    const param = [
        {
            "vname":"token_address",
            "type":"ByStr20",
            "value": tokenAddr
        },
        {
            "vname":"token_id",
            "type":"Uint256",
            "value": tokenId
        },
        {
            "vname":"payment_token_address",
            "type":"ByStr20",
            "value": payment_token_addr
        },
        {
            "vname":"sale_price",
            "type":"Uint128",
            "value": price
        },
        {
            "vname":"side",
            "type":"Uint32",
            "value": side
        },
        {
            "vname":"dest",
            "type":"ByStr20",
            "value": dest
        },
        {
            "vname":"message",
            "type":"ByStr",
            "value": msg
        },        
        {
            "vname":"signature",
            "type":"ByStr64",
            "value": signature
        }        
    ]

    SendTransaction('FulfillOrder', param, privkey, contract, price)

}

async function RegPubkey(privkey, contract, pubkey)
{ 
    const param = [
        {
            "vname":"pub_key",
            "type":"ByStr33",
            "value": pubkey
        },
    ]

    SendTransaction('SetVerifier', param, privkey, contract, 0)
}

async function ClearPubkey(privkey, contract)
{ 
    const param = []

    SendTransaction('ClearVerifier', param, privkey, contract, 0)
}



(async function() {
    privkey = '0xe53d1c3edaffc7a7bab5418eb836cf75819a82872b4a1a0f1c7fcf5c3e020b89'
    recipient = '0xd90f2e538ce0df89c8273cad3b63ec44a3c4ed82'
    buyerPrivkey = 'e7f59a4beb997a02a13e0d5e025b39a6f0adc64d37bb1e6a849a4863b4680411'
    buyerAddr = '0xb028055ea3bc78d759d10663da40d171dec992aa'
    tokenUri = 'https://ivefwfclqyyavklisqgz.supabase.co/storage/v1/object/public/nftstorage/collection_example/metadata/'

    const args = process.argv.slice(2)
    console.log(args);

    switch (args[0]) {
        case 'batchmint':
            contract = args[1]
            start = parseInt(args[2])
            count = parseInt(args[3])
            console.log('Calling batchmint starting at token ' + start + " count:" + count + " at contract " + contract)
            BatchMint(
                privkey, 
                contract, 
                recipient,
                tokenUri,
                start,
                count
            )
            break;

        case 'mint':
            contract = args[1]
            console.log('Calling single mint')              
            Mint(
                privkey, 
                contract, 
                recipient,
                tokenUri
            )
            break;

        case 'setspender':
            nftContract = args[1]
            id = args[2]
            spender = args[3]

            SetSpender(
                privkey,
                nftContract, 
                id, 
                spender
            )
            break;

        case 'setorder':
            fpContract = args[1]
            nftContract = args[2]
            id = args[3]
            side = args[4]
            wallet = args[5]
            sender = wallet == "seller" ? privkey : buyerPrivkey
            sale_price = "2000000"
            amount = sender ==  buyerPrivkey ? sale_price : "0"

            SetOrder(
                sender,
                fpContract,
                nftContract,
                id,
                sale_price, 
                side,
                "345566",   //expiry
                amount
            )
            break;

        case 'fulfillorder':
            fpContract = args[1]
            nftContract = args[2]
            id = args[3]
            side = args[4]
            wallet = args[5]
            sender = wallet == "seller" ? privkey : buyerPrivkey 
            sale_price = "2000000"
            amount = sender ==  buyerPrivkey ? sale_price : "0"

            FulfillOrder(
                privkey, //use wallet 1 as the signer
                sender,
                fpContract,
                nftContract,
                id,
                sale_price, 
                side,
                buyerAddr,
                amount
            )
            break;

        case 'regpubkey' :
            contract = args[1]
            pubkey = args[2]

            RegPubkey(
                privkey,
                contract,
                pubkey
            )
            break;

        case 'clearpubkey' :
            contract = args[1]
            ClearPubkey(
                privkey,
                contract
            )
            break;

        default:
            console.log('\nTransitions:')
            console.log('1. batchmint <zrc6 addr> <start> <count>')
            console.log('2. mint <zrc6 addr>')
            console.log('3. setspender <zrc6 addr> <token id> <fixed price addr>')
            console.log('4. setorder <fixed price addr> <nft addr> <token id>  <side: 0|1, 0 for sell 1 for buy> <wallet: buyer | seller')
            console.log('5. fulfillorder <fixed price addr> <nft addr> <token id> <side: 0|1, 0 for sell 1 for buy> <wallet: buyer | seller')
            console.log('6. regpubkey <fixed price addr> <pubkey')
            console.log('7. clearpubkey <fixed price addr>')

    }
    
    
})()

