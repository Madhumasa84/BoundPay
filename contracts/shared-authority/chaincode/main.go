package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

func main() {
	cc, err := contractapi.NewChaincode(&SharedAuthorityContract{})
	if err != nil {
		log.Panicf("create BoundPay shared authority chaincode: %v", err)
	}
	if err := cc.Start(); err != nil {
		log.Panicf("start BoundPay shared authority chaincode: %v", err)
	}
}
