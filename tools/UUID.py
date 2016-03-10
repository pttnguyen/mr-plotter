import uuid
print uuid.uuid4()

## name = raw_input("Name of mPMU: ")
serial_number = raw_input("Serial Number: ")
alias = raw_input("Alias: ")
ip_address = raw_input("IP Address: ")

alias = alias.replace(" ", "_")

def new_uuid():
    x = uuid.uuid4()
    return x


f = open('out.txt', 'w')

new_mpmu = """["""+ip_address+"""]
    %active = True
    %alias = """+alias+"""
    %serial_number = """+serial_number+"""
    [[Metadata]]
        SourceName = uPMU
        [[[Instrument]]]
            SerialNumber = """+serial_number+"""
    [[L3ANG]]
        Path = /upmu/"""+alias+"""/L3ANG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = deg
    [[LSTATE]]
        Path = /upmu/"""+alias+"""/LSTATE
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = bitmap
    [[L2MAG]]
        Path = /upmu/"""+alias+"""/L2MAG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = Volts
    [[L1MAG]]
        Path = /upmu/"""+alias+"""/L1MAG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = Volts
    [[C1MAG]]
        Path = /upmu/"""+alias+"""/C1MAG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = Amps
    [[L3MAG]]
        Path = /upmu/"""+alias+"""/L3MAG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = Volts
    [[C3ANG]]
        Path = /upmu/"""+alias+"""/C3ANG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = deg
    [[C1ANG]]
        Path = /upmu/"""+alias+"""/C1ANG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = deg
    [[L2ANG]]
        Path = /upmu/"""+alias+"""/L2ANG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = deg
    [[C2ANG]]
        Path = /upmu/"""+alias+"""/C2ANG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = deg
    [[C3MAG]]
        Path = /upmu/"""+alias+"""/C3MAG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = Amps
    [[C2MAG]]
        Path = /upmu/"""+alias+"""/C2MAG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = Amps
    [[L1ANG]]
        Path = /upmu/"""+alias+"""/L1ANG
        uuid = """+str(new_uuid()).upper()+"""
        [[[Properties]]]
            UnitofMeasure = deg
""" 

f.write(new_mpmu)

# print >> f, 'Filename:', filename  # or f.write('...\n')
f.close()

### % (str(name), str(serial_number), str(alias))
