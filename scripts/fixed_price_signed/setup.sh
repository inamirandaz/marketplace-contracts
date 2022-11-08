#!/bin/bash

ISOLATED_SERVER_PATH="/home/ina/Projects/zilliqa-isolated-server"
cd $ISOLATED_SERVER_PATH
docker rm -f isolated-server
docker run -d -p 5555:5555   --name isolated-server   isolated-server:1.0
docker container ls
cd -

# make sure the isolated server is ready
sleep 3

echo "Deploying ZRC6"
ZRC6_FILE="zrc6_rialto_v0.1.scilla"
INIT_FILE="init/init-zrc6.json"
ret=`zli contract deploy -c $ZRC6_FILE -i $INIT_FILE  -p 2000000000 -l 40000`
zrc6_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
echo $zrc6_addr

TOOL_PATH="./"
cd $TOOL_PATH
batch_size=100
node contract.js batchmint $zrc6_addr 1 $batch_size
cd -

echo "Deploying collection contract"
COLLECTION_FILE="../../contracts/collection.scilla"
COLLECTION_INIT="init/init-collection.json"
ret=`zli contract deploy -c $COLLECTION_FILE -i $COLLECTION_INIT  -p 2000000000 -l 40000`
collection_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
echo $collection_addr

echo "Deploying fixed price"
FP_FILE="../../contracts/fixed_price.scilla"
FP_INIT="init/init-fp.json"
echo "Updating fixed price contract init file"
sed -i "15s/.*/\"value\" : \"$collection_addr\"/" $FP_INIT
ret=`zli contract deploy -c $FP_FILE -i $FP_INIT  -p 2000000000 -l 50000`
fp_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
echo $fp_addr

echo "Setting the verifier pub key"
# Correct Public Key
PUBKEY="0x03d3c94c377f0fb329dc5c857f7dbd7f694eecfca377db079b68ef7285905baa0b"
# Wrong Public Key
# PUBKEY="0x0271ce4f2c23fc81299eb10592b9ec015157f390fcc7b5e1bb29169314829e02be"
node contract.js regpubkey $fp_addr $PUBKEY

echo "Sell Order Side"
SELL_SIDE=0
BUY_SIDE=1
SELLER_WALLET="seller"
BUYER_WALLET="buyer"
token_id=99
cd $TOOL_PATH
node contract.js setspender $zrc6_addr $token_id $fp_addr
node contract.js setorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $SELLER_WALLET
node contract.js fulfillorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $BUYER_WALLET 1
cd -

echo "Buy Order Side"
token_id=80
cd $TOOL_PATH
node contract.js setspender $zrc6_addr $token_id $fp_addr
node contract.js setorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $SELLER_WALLET
node contract.js setorder $fp_addr $zrc6_addr $token_id $BUY_SIDE $BUYER_WALLET
node contract.js fulfillorder $fp_addr $zrc6_addr $token_id $BUY_SIDE $SELLER_WALLET 1
cd -

echo "Disabling signed order mode"
token_id=70
cd $TOOL_PATH
node contract.js clearpubkey $fp_addr
node contract.js setspender $zrc6_addr $token_id $fp_addr
node contract.js setorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $SELLER_WALLET
#this should fail
node contract.js fulfillorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $BUYER_WALLET 1
node contract.js fulfillorder $fp_addr $zrc6_addr $token_id $SELL_SIDE $BUYER_WALLET 0
cd -

#re-enable the mode for testing later
node contract.js regpubkey $fp_addr $PUBKEY 

echo "Deploying multisig"
cd $TOOL_PATH
MSW_FILE="../../contracts/msw.scilla"
MSW_INIT="init/init-msw.json"
ret=`zli contract deploy -c $MSW_FILE -i $MSW_INIT -p 2000000000 -l 40000`
msw_addr="0x`echo "$ret" | grep "contract address" | awk '{print $(NF)}'`"
cd -



echo "Transferring ownership to multisig"

zli contract call -a $fp_addr -t SetContractOwnershipRecipient -r "[{\"vname\":\"to\",\"type\":\"ByStr20\",\"value\":\"$msw_addr\"}]"
zli contract call -a $msw_addr -t SubmitAcceptContractOwnershipTransaction -r "[{\"vname\":\"contract_address\",\"type\":\"ByStr20\",\"value\":\"$fp_addr\"}]"
zli contract call -a $msw_addr -t ExecuteTransaction -r "[{\"vname\":\"transaction_id\",\"type\":\"Uint32\",\"value\":\"0\"}]"

echo "Setting"
zli contract call -a$msw_addr -t SubmitDisableSignedOrderTransaction -r "[{\"vname\":\"contract_address\",\"type\":\"ByStr20\",\"value\":\"$fp_addr\"}]"
zli contract call -a $msw_addr -t ExecuteTransaction -r "[{\"vname\":\"transaction_id\",\"type\":\"Uint32\",\"value\":\"1\"}]"


echo "Contracts"
echo "zrc6=$zrc6_addr"
echo "collection=$collection_addr"
echo "fp=$fp_addr"
echo "msw=$msw_addr"
